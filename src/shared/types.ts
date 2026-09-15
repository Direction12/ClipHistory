/**
 * 跨进程共用类型（main / preload / renderer）。
 *
 * 纪律：main 与 renderer 不得各自复制一份定义（见 docs/编码规范.md §4）。
 * 本文件的字段与 docs/存储与数据格式规范.md §3.1 一一对应，改动必须同步该文档。
 */

/** 条目类型：文字或图片 */
export type EntryKind = 'text' | 'image';

/** 类型筛选选项（界面用） */
export type EntryFilter = 'all' | EntryKind;

/**
 * 粘贴行为模式。
 * - `auto`：写回剪贴板后尝试自动 Ctrl+V 到前台窗口
 * - `copyOnly`：只写回剪贴板，由用户自行粘贴
 */
export type PasteMode = 'auto' | 'copyOnly';

/** 图片元数据；`file` 为相对数据目录的路径，如 `images/<hash>.png` */
export interface ImageMeta {
  file: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * 列表渲染用的条目元数据（不含文本全文与图片本体，保证列表加载快）。
 * 对应 docs/存储与数据格式规范.md §3.1 的索引行。
 */
export interface ClipEntryMeta {
  id: string;
  kind: EntryKind;
  /** 内容哈希：文本 sha256(规范化字节)，图片 sha256(PNG 字节) */
  hash: string;
  /** 首次记录时间（ms, epoch） */
  createdAt: number;
  /** 最近一次复制该内容的时间（ms, epoch）；列表按此降序 */
  updatedAt: number;
  /** 是否置顶。置顶条目不参与自动清理 */
  pinned: boolean;
  /** 仅 kind === 'text'：前 120 字符预览 */
  textPreview?: string;
  /** 仅 kind === 'text'：内容是否因超长被截断 */
  truncated?: boolean;
  /** 仅 kind === 'image' */
  image?: ImageMeta;
}

/** 条目详情（按需读取，含文本全文） */
export interface ClipEntryDetail extends ClipEntryMeta {
  /** 仅 kind === 'text'：完整文本内容 */
  text?: string;
}

/** 应用设置；对应 docs/存储与数据格式规范.md §2 */
export interface Settings {
  /** 索引格式版本 */
  version: number;
  /** 存储期限（天），1–365 */
  retentionDays: number;
  /** 去重窗口（ms），0–60000 */
  dedupWindowMs: number;
  /** 粘贴行为模式 */
  pasteMode: PasteMode;
  /** 是否暂停记录 */
  paused: boolean;
  /** 窗口位置与尺寸记忆 */
  windowBounds: WindowBounds;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 统一的操作结果，避免渲染层收到未处理的异常（见 docs/编码规范.md §5） */
export interface OperationResult {
  ok: boolean;
  /** 失败原因，用于界面向用户说明「为什么」与「下一步」 */
  error?: string;
}

/** 按 id 查询的通用入参 */
export interface EntryIdPayload {
  id: string;
}

/** 列表查询入参 */
export interface EntryQueryPayload {
  query?: string;
  kind?: EntryFilter;
}

/** 置顶入参 */
export interface SetPinnedPayload {
  id: string;
  pinned: boolean;
}

/**
 * preload 经 contextBridge 暴露给渲染层的白名单 API。
 * 渲染层通过 `window.clipHistory` 访问（见 src/renderer/global.d.ts）。
 */
export interface ClipHistoryApi {
  /** 应用版本号，用于界面展示与排查 */
  readonly appVersion: string;
  /** 骨架期的连通性自检，确认 IPC 通路可用 */
  ping(): Promise<{ ok: boolean; message: string }>;
}
