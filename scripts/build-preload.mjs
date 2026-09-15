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
const PRELOAD_SOURCE = join(PROJECT_ROOT, 'src', 'preload', 'preload.ts');
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

/**
 * 允许被 preload 使用的共享常量白名单。
 *
 * 为什么要有白名单：preload 是自包含打包，**凡是被它 import 的常量都必须在这里内联**，
 * 漏掉一个就会在运行时报 `XXX is not defined` —— 而这类错误发生在渲染层调用事件订阅时，
 * 表现为界面卡在「正在加载…」，排查成本很高（本项目真实踩过：漏了 IPC_EVENT）。
 * 因此这里对 preload 的导入做**穷尽校验**，不认识的名字直接让构建失败。
 */
const INLINEABLE_CONSTANTS = {
  IPC_INVOKE: (source) => extractLiteral(source, 'IPC_INVOKE'),
  IPC_EVENT: (source) => extractLiteral(source, 'IPC_EVENT'),
  RENDERER_API_KEY: (source) => {
    const match = /export const RENDERER_API_KEY\s*=\s*'([^']+)'/.exec(source);
    if (match === null) {
      throw new Error('无法从 src/shared/constants.ts 提取常量 RENDERER_API_KEY');
    }
    return JSON.stringify(match[1]);
  },
};

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

let output = readFileSync(COMPILED_PRELOAD, 'utf8');

// tsc 会把 `import { X } from '../shared/constants'` 编译为
// `const constants_1 = require("../shared/constants");`，并在使用处写成 `constants_1.X`。
// 因此需要三步：① 读出源码里实际 import 了哪些常量（穷尽校验）；
// ② 把 require 行换成这些常量的字面量；③ 剥掉所有别名前缀。
const sourceImports = /^import \{([^}]*)\} from '\.\.\/shared\/constants';$/m.exec(
  readFileSync(PRELOAD_SOURCE, 'utf8'),
);
if (sourceImports === null) {
  throw new Error('未在 src/preload/preload.ts 找到对 ../shared/constants 的导入');
}
const importedNames = sourceImports[1]
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name !== '');

const requireLinePattern = /^const (\w+) = require\(["']\.\.\/shared\/constants["']\);$/m;
const requireLine = requireLinePattern.exec(output);
if (requireLine === null) {
  throw new Error('未在 preload 产物中找到对 shared/constants 的 require，无法内联常量');
}
const importAlias = requireLine[1];

// 穷尽校验：preload import 的每个常量都必须能内联，否则构建失败
// （漏掉一个就会在运行时报 `XXX is not defined`，表现为界面卡在「正在加载…」）
const declarations = importedNames.map((name) => {
  const resolver = INLINEABLE_CONSTANTS[name];
  if (resolver === undefined) {
    throw new Error(
      `preload 导入了打包器尚不支持内联的常量「${name}」。` +
        '请在 scripts/build-preload.mjs 的 INLINEABLE_CONSTANTS 中登记它，' +
        '否则产物会因缺少该常量而在运行时报错。',
    );
  }
  return `const ${name} = ${resolver(sharedSource)};`;
});

output = output.replace(requireLinePattern, declarations.join('\n'));
// 把 `constants_1.IPC_INVOKE` 还原为 `IPC_INVOKE`
output = output.replace(new RegExp(`\\b${importAlias}\\.`, 'g'), '');

if (output.includes(`${importAlias}.`)) {
  throw new Error(`preload 产物仍引用未定义的导入别名：${importAlias}`);
}

// 关键校验：产物里用到但没被声明的常量会让 preload 在运行时抛错，
// 因此这里逐个确认「源码里出现过名字」的常量确实都被声明了。
for (const name of Object.keys(INLINEABLE_CONSTANTS)) {
  const usedInOutput = new RegExp(`\\b${name}\\b`).test(output);
  const declared = new RegExp(`const ${name} =`).test(output);
  if (usedInOutput && !declared) {
    throw new Error(`preload 产物使用了 ${name} 但没有内联声明（会导致运行时报错）`);
  }
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
