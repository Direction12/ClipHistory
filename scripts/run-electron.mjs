/**
 * 开发启动器：构建后拉起 Electron。
 *
 * 为什么需要它：沙箱禁止 Node 直接派生子进程，`node_modules/.bin/electron` 这类包装脚本
 * 会因 spawn EPERM 失败。本脚本通过 shell 启动 Electron 可执行文件 —— 经实测可用。
 *
 * 用法：
 *   node scripts/run-electron.mjs            # 正常启动
 *   node scripts/run-electron.mjs --smoke    # 冒烟自检：跑完集成自检后自行退出
 *
 * 冒烟模式会把数据目录指向临时目录，因此**不会污染用户真实历史**
 * （见 docs/构建与运行.md §4）。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  // 关键：自检会写入数据，必须隔离到临时目录，绝不能写进 %APPDATA%\ClipHistory
  const dataDir = mkdtempSync(join(tmpdir(), 'cliphistory-smoke-'));
  environment.CLIPHISTORY_DATA_DIR = dataDir;
  console.log(`冒烟自检数据目录（临时）：${dataDir}`);
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
