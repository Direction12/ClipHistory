/**
 * 构建编排：主进程/preload → 渲染层 → 静态资源。
 *
 * 为什么不用 `npm run build:main && npm run build:renderer`：本机沙箱禁止 Node 直接
 * 派生进程（child_process 报 EPERM），npm 的脚本串联会失败。此处用 spawnSync + shell
 * 启动 Node 执行 tsc 与资源拷贝脚本 —— 与 run-electron.mjs 同一套、经实测可用的方式。
 *
 * 等价于依次执行：build:main、build:renderer。
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

/** 顺序执行一条命令；失败即中止整个构建，避免产出半成品 */
function run(description, scriptPath, args) {
  console.log(`→ ${description}`);
  // 不使用 shell：Windows 上 shell 会把含空格的 process.execPath（C:\Program Files\...）拆断。
  const result = spawnSync(process.execPath, [join(PROJECT_ROOT, scriptPath), ...args], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });

  if (result.error !== undefined) {
    throw new Error(`${description} 无法启动：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${description} 失败，退出码 ${String(result.status)}`);
  }
}

const tscEntry = join('node_modules', 'typescript', 'bin', 'tsc');

run('编译主进程（CommonJS）', tscEntry, ['-p', 'tsconfig.node.json']);
run('打包 preload 为自包含单文件', join('scripts', 'build-preload.mjs'), []);
run('编译渲染层（ESM）', tscEntry, ['-p', 'tsconfig.renderer-build.json']);
run('搬移渲染层静态资源与图标', join('scripts', 'copy-static.mjs'), []);

console.log('构建完成：dist/main、dist/preload/preload.js、dist/renderer');
