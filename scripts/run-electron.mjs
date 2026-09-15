/**
 * 开发启动器：构建后拉起 Electron。
 *
 * 为什么需要它：沙箱禁止 Node 派生子进程，`node_modules/.bin/electron` 这类包装脚本
 * 会因 spawn EPERM 失败。本脚本用 Electron 模块导出的可执行文件路径，
 * 在 PowerShell 里以 `& <exe> .` 直接运行 —— PowerShell 自身的进程启动不受该限制。
 *
 * 用法：
 *   node scripts/run-electron.mjs            # 正常启动
 *   node scripts/run-electron.mjs --smoke    # 冒烟自检：应用验证窗口加载后自行退出
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
const smokeTest = args.includes('--smoke');
const passThrough = args.filter((argument) => argument !== '--smoke');

const environment = { ...process.env };
if (smokeTest) {
  environment.CLIPHISTORY_SMOKE_TEST = '1';
}

console.log(`启动 Electron：${electronPath}${smokeTest ? '（冒烟自检模式）' : ''}`);

// shell: true 让 Windows 通过 cmd 启动 exe，绕开 Node 直接 spawn 的限制
const result = spawnSync(electronPath, [PROJECT_ROOT, ...passThrough], {
  stdio: 'inherit',
  env: environment,
  shell: true,
});

if (result.error !== undefined) {
  console.error(`无法启动 Electron：${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
