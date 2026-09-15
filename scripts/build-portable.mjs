/**
 * 免安装包组装：复用**已存在的 Electron 运行时**，产出可直接双击运行的应用目录。
 *
 * ## 为什么不用 electron-builder 生成安装包
 *
 * 实测（见 docs/构建与运行.md §2.3 与 C-19）：electron-builder 的**打包动作本身可用**
 * （能走到 `packaging` 阶段），但它**必须从 GitHub 下载 Electron 发行版**（约 367MB）——
 * 而本环境 `github.com` 不可达（`connect ETIMEDOUT 20.205.243.166:443`）。
 *
 * 好消息是 Electron 运行时已经随 `npm install` 下载到 `node_modules/electron/dist`，
 * 因此可以**直接复用它**组装免安装包：不需要网络、也不需要 electron-builder。
 *
 * ## 产物结构（Electron 约定的布局）
 *
 * ```
 * release/ClipHistory-win-x64/
 *   ClipHistory.exe            ← 由 electron.exe 改名而来
 *   *.dll / *.pak / *.bin / locales/ ...
 *   resources/
 *     app/                     ← 应用代码（package.json 的 main 指向 dist/main/main.js）
 *       dist/ assets/ package.json
 *     assets/                  ← app.isPackaged 时托盘图标取这里（见 main.ts resolveAssetsDir）
 *     default_app.asar         ← 删掉，否则可能与我们的 app 冲突
 * ```
 *
 * 用法：node scripts/build-portable.mjs
 */

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

const ELECTRON_DIST = join(PROJECT_ROOT, 'node_modules', 'electron', 'dist');
const RELEASE_DIR = join(PROJECT_ROOT, 'release');
const APP_NAME = 'ClipHistory';

/** 组装产物需要包含的应用文件（与 electron-builder 的 files 配置保持一致） */
const APP_FILES = ['dist', 'assets', 'package.json'];

/**
 * 组装免安装包。返回产物路径与体积（供调用方与自检使用）。
 */
export function buildPortable() {
  requireExists(ELECTRON_DIST, 'Electron 运行时');
  requireExists(join(ELECTRON_DIST, 'electron.exe'), 'Electron 可执行文件');
  requireExists(join(PROJECT_ROOT, 'dist', 'main', 'main.js'), '构建产物（dist/main/main.js）');

  const outputDir = join(RELEASE_DIR, `${APP_NAME}-win-x64`);

  // 每次都从干净目录开始，避免上一次的残留混进产物
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  // 1) 复制 Electron 运行时（含 locales 等全部文件）
  cpSync(ELECTRON_DIST, outputDir, { recursive: true });

  // 2) 改名为产品名，让任务管理器/开始菜单里显示正确名字
  const renamedExe = join(outputDir, `${APP_NAME}.exe`);
  renameSync(join(outputDir, 'electron.exe'), renamedExe);

  // 3) 放置应用代码到 resources/app
  const resourcesDir = join(outputDir, 'resources');
  const appDir = join(resourcesDir, 'app');
  mkdirSync(appDir, { recursive: true });

  let appBytes = 0;
  for (const entry of APP_FILES) {
    const from = join(PROJECT_ROOT, entry);
    requireExists(from, `应用文件 ${entry}`);
    cpSync(from, join(appDir, entry), { recursive: true });
    appBytes += directorySize(from);
  }

  // 4) 托盘/窗口图标也放到 resources/assets：
  //    app.isPackaged 时 main.ts 的 resolveAssetsDir() 指向这里
  cpSync(join(PROJECT_ROOT, 'assets'), join(resourcesDir, 'assets'), { recursive: true });

  // 5) 删除 Electron 自带示例应用，避免与我们的 app 冲突
  for (const leftover of ['default_app.asar', 'app.asar']) {
    rmSync(join(resourcesDir, leftover), { force: true });
  }

  return { outputDir, executable: renamedExe, appBytes };
}

/** 断言路径存在，否则给出可行动的报错 */
function requireExists(path, what) {
  if (!existsSync(path)) {
    throw new Error(`${what}不存在：${path}。请先运行 npm install 与 npm run build`);
  }
}

/** 递归统计目录体积，用于产出报告与体积核对 */
function directorySize(path) {
  const info = statSync(path);
  if (!info.isDirectory()) {
    return info.size;
  }
  let total = 0;
  for (const name of readdirSync(path)) {
    total += directorySize(join(path, name));
  }
  return total;
}

function main() {
  console.log('→ 正在组装免安装包（复用本地 Electron 运行时，无需网络）…');
  const result = buildPortable();
  const totalBytes = directorySize(join(result.outputDir));
  console.log(`→ 完成：${result.outputDir}`);
  console.log(`   可执行文件：${result.executable}`);
  console.log(`   整包体积：${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
}

// 仅在作为脚本直接运行时执行
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`组装失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
