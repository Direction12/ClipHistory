/**
 * Windows 原生剪贴板与按键注入。
 *
 * ## 为什么必须用 PowerShell 而不是 Electron API
 *
 * 经运行时实测（Electron 44，见 docs/技术方案.md C-05）：
 *
 * | 操作 | Electron API | 实测结果 |
 * |---|---|---|
 * | 写文字 | `clipboard.writeText()` | ✅ 可用 |
 * | 读图片 | `clipboard.read()` + `getType('image/png')` | ✅ 可用 |
 * | **写图片** | `clipboard.write([new ClipboardItem(...)])` | ❌ **返回成功但实际没写进去**（读回时 types 为空） |
 * | **模拟按键** | 无此能力 | ❌ Electron 无法向其它应用注入按键 |
 *
 * 因此这两件事改由系统自带的 PowerShell 完成：
 * - 写图片：`System.Drawing` 加载 PNG → `Clipboard::SetImage`（实测读回 `has('image/png') === true`）
 * - 模拟按键：`System.Windows.Forms.SendKeys::SendWait('^v')`（实测退出码 0）
 *
 * **不引入任何第三方依赖**（见 docs/编码规范.md §1），代价是每次调用要启动一次 PowerShell。
 * 这两件事都只在用户点按钮时发生，不是高频路径。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationResult } from '../shared/types';

/** 外部命令执行结果 */
export interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** 进程未能启动时的原因（与「启动了但退出码非 0」区分） */
  readonly spawnError?: string;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

const POWERSHELL_TIMEOUT_MS = 15_000;

/** 默认实现：调用 powershell.exe 并捕获输出；永不抛异常，失败信息放在返回值里 */
export const runCommand: CommandRunner = (file, args) =>
  new Promise<CommandResult>((resolve) => {
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let child;
    try {
      child = spawn(file, [...args], { windowsHide: true });
    } catch (error) {
      finish({
        ok: false,
        stdout: '',
        stderr: '',
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({ ok: false, stdout, stderr, spawnError: error.message });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, stdout, stderr });
    });

    // 兜底：PowerShell 卡住时不能把界面一起拖死
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 忽略
      }
      finish({ ok: false, stdout, stderr, spawnError: `命令超时（${String(POWERSHELL_TIMEOUT_MS)}ms）` });
    }, POWERSHELL_TIMEOUT_MS);
    timer.unref?.();
  });

export interface NativeClipboardOptions {
  readonly run: CommandRunner;
  /** 临时文件目录；默认用系统临时目录 */
  readonly tempDir?: string;
}

/** 把 PowerShell 的单引号字符串字面量做转义（路径可能含单引号） */
function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 从 PowerShell 的输出/错误里提炼一句可读的失败原因 */
function explainFailure(result: CommandResult): string {
  if (result.spawnError !== undefined) {
    return `无法启动 PowerShell：${result.spawnError}`;
  }
  const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(0, 3).join(' ').trim();
  return detail === '' ? `PowerShell 退出码非 0（未提供错误信息）` : detail;
}

/**
 * 把 PNG 字节写入 Windows 剪贴板（作为真正的图片）。
 *
 * 实现路径：写临时 PNG 文件 → PowerShell 用 System.Drawing 载入 → `Clipboard::SetImage`。
 * 走文件而不是 base64 参数，是为了避开命令行长度限制并保留原始字节。
 */
export async function writePngToClipboard(
  pngBytes: Buffer,
  options: NativeClipboardOptions,
): Promise<OperationResult> {
  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(options.tempDir ?? tmpdir(), 'cliphistory-img-'));
    const pngPath = join(workDir, 'clip.png');
    await writeFile(pngPath, pngBytes);

    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      `$image = [System.Drawing.Image]::FromFile(${quoteForPowerShell(pngPath)})`,
      '$bitmap = New-Object System.Drawing.Bitmap($image)',
      '[System.Windows.Forms.Clipboard]::SetImage($bitmap)',
      '$image.Dispose()',
      '$bitmap.Dispose()',
      "Write-Output 'OK'",
    ].join('; ');

    // -STA 是 Windows.Forms 剪贴板访问的必要条件（否则会抛线程模式异常）
    const result = await options.run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-Command',
      script,
    ]);

    if (!result.ok) {
      return { ok: false, error: `写入图片到剪贴板失败：${explainFailure(result)}` };
    }
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `写入图片到剪贴板失败：${reason}` };
  } finally {
    if (workDir !== null) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * 向当前前台窗口发送 Ctrl+V。
 *
 * **已知限制（LIM-01）**：以管理员权限运行的窗口不会接收模拟按键，
 * 此时 SendKeys 通常**不报错但也不生效** —— 这是平台限制，无法可靠探测，
 * 因此调用方必须向用户说明「若未粘贴请手动 Ctrl+V」，不能假装成功。
 */
export async function sendPasteKeys(options: NativeClipboardOptions): Promise<OperationResult> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    "[System.Windows.Forms.SendKeys]::SendWait('^v')",
    "Write-Output 'OK'",
  ].join('; ');

  const result = await options.run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-Command',
    script,
  ]);

  if (!result.ok) {
    return { ok: false, error: `发送粘贴按键失败：${explainFailure(result)}` };
  }
  return { ok: true };
}
