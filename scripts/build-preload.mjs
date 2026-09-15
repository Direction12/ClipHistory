/**
 * 把 preload 打包成自包含的单文件 dist/preload/preload.js。
 *
 * 为什么要打包：`sandbox: true` 下的 preload 无法 require 相对模块（实测报
 * `module not found: ../shared/constants`），因此必须把共享常量内联进产物。
 *
 * 为什么不用 esbuild/rollup：本机文件沙箱禁止 Node 派生进程，原生打包器无法运行
 * （见 docs/构建与运行.md §2.1）。
 *
 * 流程：
 *   1. 用 tsc + tsconfig.preload.json 把源码编译为 CommonJS（类型由编译器剥离，
 *      避免手写正则去猜类型语法）；
 *   2. 抽出产物里对 shared/constants 的 require 行；
 *   3. 用共享常量源码中的字面量替换该行 —— preload 产物从此只依赖 electron 内置模块。
 *
 * 用法：node scripts/build-preload.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

const SHARED_CONSTANTS_TS = join(PROJECT_ROOT, 'src', 'shared', 'constants.ts');
const COMPILED_PRELOAD = join(PROJECT_ROOT, 'dist', 'preload-tmp', 'preload', 'preload.js');
const TEMP_DIR = join(PROJECT_ROOT, 'dist', 'preload-tmp');
const OUTPUT_DIR = join(PROJECT_ROOT, 'dist', 'preload');
const OUTPUT_FILE = join(OUTPUT_DIR, 'preload.js');

/** 从共享常量源码里提取一个导出常量的字面量文本 */
function extractLiteral(source, name) {
  const match = new RegExp(`export const ${name}\\s*=\\s*([\\s\\S]*?)\\s+as const;`).exec(source);
  if (match === null) {
    throw new Error(`无法从 src/shared/constants.ts 提取常量 ${name}`);
  }
  return match[1];
}

// 1. 编译：类型由 tsc 剥离，产出 CommonJS
const tscResult = spawnSync(
  process.execPath,
  [join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.preload.json'],
  { cwd: PROJECT_ROOT, stdio: 'inherit' },
);
if (tscResult.status !== 0) {
  throw new Error(`preload 编译失败，退出码 ${String(tscResult.status)}`);
}

// 2. 内联共享常量
const sharedSource = readFileSync(SHARED_CONSTANTS_TS, 'utf8');
const ipcInvokeLiteral = extractLiteral(sharedSource, 'IPC_INVOKE');
const apiKeyMatch = /export const RENDERER_API_KEY\s*=\s*'([^']+)'/.exec(sharedSource);
if (apiKeyMatch === null) {
  throw new Error('无法从 src/shared/constants.ts 提取常量 RENDERER_API_KEY');
}

let output = readFileSync(COMPILED_PRELOAD, 'utf8');

// tsc 会把 `import { X } from '../shared/constants'` 编译为
// `const constants_1 = require("../shared/constants");`，并在使用处写成 `constants_1.X`。
// 因此需要两步：先取出别名，再把 require 行换成字面量，最后剥掉所有别名前缀。
const requireLinePattern = /^const (\w+) = require\(["']\.\.\/shared\/constants["']\);$/m;
const requireLine = requireLinePattern.exec(output);
if (requireLine === null) {
  throw new Error('未在 preload 产物中找到对 shared/constants 的 require，无法内联常量');
}
const importAlias = requireLine[1];

output = output.replace(
  requireLinePattern,
  `const IPC_INVOKE = ${ipcInvokeLiteral};\nconst RENDERER_API_KEY = ${JSON.stringify(apiKeyMatch[1])};`,
);
// 把 `constants_1.IPC_INVOKE` 还原为 `IPC_INVOKE`
output = output.replace(new RegExp(`\\b${importAlias}\\.`, 'g'), '');

if (output.includes(`${importAlias}.`)) {
  throw new Error(`preload 产物仍引用未定义的导入别名：${importAlias}`);
}

// 产物里不允许再残留任何相对 require，否则 sandbox 下必然加载失败
const leftover = /require\(["']\.[^"']*["']\)/.exec(output);
if (leftover !== null) {
  throw new Error(`preload 产物仍存在相对 require：${leftover[0]}`);
}

// 3. 输出并清理临时目录
const banner = '/* 由 scripts/build-preload.mjs 生成，请勿直接编辑；源文件：src/preload/preload.ts */\n';
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(OUTPUT_FILE, banner + output, 'utf8');
rmSync(TEMP_DIR, { recursive: true, force: true });

console.log(`→ preload 已打包为自包含单文件：dist/preload/preload.js（${(banner + output).length} 字节）`);
