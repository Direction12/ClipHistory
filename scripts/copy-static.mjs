/**
 * 渲染层静态资源拷贝。
 *
 * 为什么需要它：渲染层用 tsc 编译，而 tsc 只处理 .ts，不搬运 .html / .css / 图片。
 * 本脚本把 src/renderer 下的非 TS 文件与 assets/ 复制到与编译产物相同的目录，
 * 使 index.html 里的相对引用（./styles.css、./assets/icon.png）在 dist 下依然成立。
 *
 * 为什么不用 Vite：本机文件沙箱禁止 Node 派生进程，Vite 的 rolldown/esbuild 原生工具链
 * 无法工作；tsc 是纯 JS，可在进程内完成编译。详见 docs/构建与运行.md §2.1。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

/** 需要搬运的非 TS 文件扩展名 */
const STATIC_EXTENSIONS = ['.html', '.css', '.png', '.ico', '.svg'];

function copyStaticFiles(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) {
    return 0;
  }

  let copied = 0;
  mkdirSync(targetDir, { recursive: true });

  for (const name of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, name);

    if (statSync(sourcePath).isDirectory()) {
      copied += copyStaticFiles(sourcePath, join(targetDir, name));
      continue;
    }

    if (STATIC_EXTENSIONS.some((extension) => name.endsWith(extension))) {
      cpSync(sourcePath, join(targetDir, name));
      copied += 1;
    }
  }

  return copied;
}

// 与 tsconfig.renderer-build.json 的 rootDir=src / outDir=dist/renderer 对应：
// src/renderer/index.html → dist/renderer/renderer/index.html（与编译出的 main.js 同级）
const rendererTarget = join(PROJECT_ROOT, 'dist', 'renderer', 'renderer');
const copied = copyStaticFiles(join(PROJECT_ROOT, 'src', 'renderer'), rendererTarget);
console.log(`→ 渲染层静态资源：${copied} 个文件 → dist/renderer/renderer/`);

// 图标放进渲染层同级 assets/，使 index.html 可用 ./assets/icon.png 引用
const assetsSource = join(PROJECT_ROOT, 'assets');
if (existsSync(assetsSource)) {
  cpSync(assetsSource, join(rendererTarget, 'assets'), { recursive: true });
  console.log('→ 图标资源：assets/ → dist/renderer/renderer/assets/');
}

// 清理 tsc 为「只有类型、无运行时代码」的 shared 文件生成的空模块，保持产物干净
for (const generated of ['dist/renderer/shared/types.js', 'dist/renderer/shared/types.js.map']) {
  const generatedPath = join(PROJECT_ROOT, generated);
  if (existsSync(generatedPath)) {
    rmSync(generatedPath);
  }
}
