/**
 * 缩略图协议：把数据目录里的图片**安全地**交给渲染层。
 *
 * ## 为什么需要它
 *
 * 渲染层跑在 `sandbox: true` + `contextIsolation: true` 下，**不能直接读文件**；
 * 而我们要在卡片上显示真实缩略图（见 docs/需求规格说明书.md 与 Phase 6 的 P6-06）。
 *
 * 常见做法有两种，都被否决：
 * - 放宽 sandbox 或用 `webSecurity: false` → 破坏安全边界（见 CLAUDE.md §5.4，永久禁止）
 * - 把数据目录的绝对路径交给渲染层 → 等于向不可信的渲染层暴露任意文件读取入口
 *
 * 采用的做法：注册一个**只读的自定义协议** `clipimg://`，主进程负责校验与读取。
 *
 * ## 安全设计（逐条都必要）
 *
 * 1. 只接受文件名（单个路径段），拒绝任何含分隔符或 `..` 的输入 —— 见 C-17。
 * 2. 解析出的绝对路径必须**确实位于 `images/` 目录内**，否则拒绝（防路径穿越）。
 * 3. 只允许 `.png` 扩展名。
 * 4. 不做任何写入操作，纯只读。
 * 5. 找不到文件时返回 404，渲染层据此显示「图片已丢失」。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { protocol } from 'electron';
import type { DataPaths } from './paths';

/** 协议名；渲染层用 `clipimg://<文件名>` 引用 */
export const IMAGE_PROTOCOL = 'clipimg';

/** 允许的扩展名（图片统一按 PNG 落地，见 docs/存储与数据格式规范.md §6） */
const ALLOWED_EXTENSION = '.png';

/** 单张图片的大小上限，防止误传超大文件把界面拖垮 */
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * 校验传入的「文件名」是否安全。
 *
 * 这是整个协议的安全闸门，因此判定必须是**白名单式**的：
 * 只允许「不含任何路径分隔符、不含 `..`、以 .png 结尾」的普通文件名。
 */
export function isSafeImageName(name: string): boolean {
  if (name === '' || name.length > 128) {
    return false;
  }
  // 任何形式的路径分隔符一律拒绝（含 Windows 的反斜杠与 URL 编码后的形式）
  if (name.includes('/') || name.includes('\\') || name.includes('%2f') || name.includes('%5c')) {
    return false;
  }
  if (name.includes('..')) {
    return false;
  }
  // 拒绝盘符与冒号（Windows 绝对路径）
  if (name.includes(':')) {
    return false;
  }
  return name.toLowerCase().endsWith(ALLOWED_EXTENSION);
}

/** 把绝对路径规范化后确认它落在 images 目录内 */
function isInsideImagesDir(imagesDir: string, candidate: string): boolean {
  const normalizedDir = resolve(imagesDir);
  const normalizedFile = resolve(candidate);
  // 必须完全相等或以目录分隔符结尾，避免 "images-evil" 这类前缀绕过
  return normalizedFile.startsWith(normalizedDir.endsWith(sep) ? normalizedDir : normalizedDir + sep);
}

export interface ThumbnailStoreOptions {
  readonly paths: DataPaths;
}

/**
 * 注册 `clipimg://` 协议处理器。
 *
 * 必须在 app ready 之后调用（`protocol.handle` 要求 ready）。
 */
export function registerImageProtocol(options: ThumbnailStoreOptions): void {
  const imagesDir = options.paths.imagesDir;

  protocol.handle(IMAGE_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url);
      // clipimg://<name> 会把 name 放在 host 里；也兼容 clipimg:///name 的写法
      const rawName = url.hostname !== '' ? url.hostname : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const fileName = decodeURIComponent(rawName);

      if (!isSafeImageName(fileName)) {
        return new Response('非法的图片名称', { status: 400 });
      }

      const candidate = join(imagesDir, fileName);
      if (!isInsideImagesDir(imagesDir, candidate)) {
        return new Response('拒绝越界访问', { status: 403 });
      }

      const info = await stat(candidate).catch(() => null);
      if (info === null || !info.isFile()) {
        return new Response('图片不存在', { status: 404 });
      }
      if (info.size > MAX_BYTES) {
        return new Response('图片过大', { status: 413 });
      }

      const bytes = await readFile(candidate);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`缩略图协议出错：${reason}`);
      return new Response('内部错误', { status: 500 });
    }
  });
}

/**
 * 启动时清理孤儿缩略图。
 *
 * 为什么需要：卡片缩略图会大量读盘，若数据目录里堆着无人引用的 PNG 会拖慢列表。
 * 这里只做「清理未被索引引用的文件」，复用 store 已有的回收逻辑即可，
 * 因此本函数仅用于**启动期的诊断**，不重复实现回收。
 */
export async function countImageFiles(paths: DataPaths): Promise<number> {
  try {
    const names = await readdir(paths.imagesDir);
    return names.filter((name) => name.toLowerCase().endsWith(ALLOWED_EXTENSION)).length;
  } catch {
    return 0;
  }
}
