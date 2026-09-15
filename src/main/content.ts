/**
 * 文本与图片内容的规范化、哈希与预览。
 *
 * 唯一真源：docs/存储与数据格式规范.md §4（哈希）与 §5（文本全文）。
 * 独立成模块的原因：这些是纯函数，是去重正确性的核心，必须能被直接单测（T-06、T-07）。
 */

import { createHash } from 'node:crypto';
import { MAX_TEXT_LENGTH, TEXT_PREVIEW_LENGTH } from '../shared/constants';

/** 文本是否应被忽略（空串、纯空白、仅换行） */
export function shouldIgnoreText(text: string): boolean {
  return text.trim() === '';
}

/**
 * 规范化文本用于哈希与存储：
 * - 去掉 UTF-8 BOM（Windows 应用复制出来的文本常带 BOM）
 * - 统一换行 `\r\n` / `\r` → `\n`
 * - **不去除**首尾空白：只做「是否为空」的判定，不改变用户实际复制的内容
 */
export function normalizeText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 文本内容哈希：SHA-256 of 规范化后的 UTF-8 字节 */
export function hashText(normalizedText: string): string {
  return createHash('sha256').update(normalizedText, 'utf8').digest('hex');
}

/** 图片内容哈希：SHA-256 of 原始 PNG 字节（不是位图数组） */
export function hashImage(pngBytes: Buffer): string {
  return createHash('sha256').update(pngBytes).digest('hex');
}

export interface TruncatedText {
  readonly text: string;
  readonly truncated: boolean;
}

/** 按上限截断文本；超出时标记 truncated，界面上要明示（见 docs/设计规范.md §5） */
export function truncateText(normalizedText: string): TruncatedText {
  if (normalizedText.length <= MAX_TEXT_LENGTH) {
    return { text: normalizedText, truncated: false };
  }
  return { text: normalizedText.slice(0, MAX_TEXT_LENGTH), truncated: true };
}

/** 生成列表用的预览文本 */
export function buildPreview(normalizedText: string): string {
  const flat = normalizedText.replace(/\s+/g, ' ').trim();
  return flat.length <= TEXT_PREVIEW_LENGTH ? flat : `${flat.slice(0, TEXT_PREVIEW_LENGTH)}…`;
}

/** 大小写不敏感的包含判定；空查询一律视为匹配 */
export function containsQuery(haystack: string, lowerCaseQuery: string): boolean {
  if (lowerCaseQuery === '') {
    return true;
  }
  return haystack.toLowerCase().includes(lowerCaseQuery);
}
