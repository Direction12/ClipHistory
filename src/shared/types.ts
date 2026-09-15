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
  /** 仅 kind === 'text'：全文文件是否仍在。false 表示「全文已丢失」 */
  textAvailable?: boolean;
  /** 仅 kind === 'image'：图片文件是否仍在。false 表示「图片已丢失」 */
  imageAvailable?: boolean;
  /** 仅 kind === 'image' */
  image?: ImageMeta;
}

/** 条目详情（按需读取，含文本全文） */
export interface ClipEntryDetail extends ClipEntryMeta {
  /** 仅 kind === 'text'：完整文本内容 */
  text?: string;
}

/**
 * 应用设置；对应 docs/存储与数据格式规范.md §2。
 *
 * 变更记录（见 docs/需求规格说明书.md §9）：
 * - 2026-09-15 CH-01 删除 `pasteMode`：卡片已同时提供「复制」「粘贴」两个按钮，设置项多余。
 * - 2026-09-15 CH-02 新增 `alwaysOnTop`：让窗口能常驻在最前。
 * - 2026-09-15 CH-03 新增 `opacity`：窗口常驻时避免过度遮挡。
 */
export interface Settings {
  /** 索引格式版本 */
  version: number;
  /** 存储期限（天），1–365 */
  retentionDays: number;
  /** 去重窗口（ms），0–60000 */
  dedupWindowMs: number;
  /** 是否暂停记录 */
  paused: boolean;
  /** 窗口是否置顶（始终显示在最前） */
  alwaysOnTop: boolean;
  /** 窗口透明度，0.4–1（1 为完全不透明） */
  opacity: number;
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

/**
 * 自动粘贴结果。
 *
 * 为什么不用 `error` 表达「已复制但未能自动粘贴」：那是一个 `ok: true` 的
 * 部分成功场景，塞进 `error` 会让渲染层无法判断该当成功还是失败来提示。
 * 因此拆成 `autoPasted`（是否真的粘贴了）与 `notice`（如实告知用户下一步）。
 *
 * 注意：不再有 `mode` 字段 —— 「粘贴模式」设置已删除（见需求 CH-01），
 * 卡片上的「复制」与「粘贴」两个按钮各自对应一个通道。
 */
export interface PasteResult extends OperationResult {
  /** 是否已把内容自动粘贴到前台窗口 */
  autoPasted: boolean;
  /** 面向用户的补充说明，例如「请按 Ctrl+V」 */
  notice?: string;
}

/** 清空历史的结果 */
export interface ClearResult {
  removed: number;
}

/**
 * 诊断信息：只有计数与运行状态，**绝不包含任何剪贴板内容**
 * （见 CLAUDE.md §5.6 与 docs/编码规范.md §6）。
 */
export interface DiagnosticsInfo {
  readonly entries: number;
  readonly text: number;
  readonly image: number;
  readonly pinned: number;
  /** 索引中被跳过的损坏行数 */
  readonly damagedLines: number;
  readonly paused: boolean;
  readonly watcherRunning: boolean;
  readonly cleanupRunning: boolean;
  /** 数据目录绝对路径，便于用户定位与备份 */
  readonly dataRoot: string;
}

/**
 * 把某条历史写回剪贴板的能力。
 * Phase 4 只实现文本；图片写回依赖 Phase 5 的修订方案（见 docs/技术方案.md C-05）。
 */
export interface PasteService {
  /** 仅写回剪贴板，不尝试自动粘贴 */
  writeEntryToClipboard(id: string): Promise<OperationResult>;
  /** 写回剪贴板并尝试自动粘贴到前台窗口；自动粘贴不可用时降级并说明 */
  pasteEntryToActiveWindow(id: string): Promise<PasteResult>;
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
 *
 * 纪律（见 docs/技术方案.md §5 契约纪律）：
 * - 所有方法返回 `{ ok, data }` 或 `{ ok: false, error }`，渲染层只需判断 `ok`；
 * - 绝不暴露 `ipcRenderer` 原始对象、`require`、`process`；
 * - 事件订阅返回取消订阅函数，便于界面卸载时清理。
 */
export interface ClipHistoryApi {
  /** 主进程是否已就绪（含健康串，不含任何剪贴板内容） */
  ping(): Promise<IpcEnvelope<{ ok: boolean; message: string }>>;

  /** 诊断计数与运行状态 */
  diagnostics(): Promise<IpcEnvelope<DiagnosticsInfo>>;

  /** 按关键词与类型取列表（含预览，不含文本全文） */
  listEntries(payload?: EntryQueryPayload): Promise<IpcEnvelope<ClipEntryMeta[]>>;

  /** 按 id 取详情（文本条目才带全文） */
  getEntry(payload: EntryIdPayload): Promise<IpcEnvelope<ClipEntryDetail | null>>;

  /** 置顶 / 取消置顶 */
  setPinned(payload: SetPinnedPayload): Promise<IpcEnvelope<ClipEntryMeta | null>>;

  /** 删除单条 */
  deleteEntry(payload: EntryIdPayload): Promise<IpcEnvelope<boolean>>;

  /** 撤销删除 */
  restoreEntry(payload: EntryRestorePayload): Promise<IpcEnvelope<ClipEntryMeta>>;

  /** 清空历史（始终保留置顶条目） */
  clearEntries(): Promise<IpcEnvelope<ClearResult>>;

  /** 仅复制到剪贴板 */
  copyEntry(payload: EntryIdPayload): Promise<IpcEnvelope<OperationResult>>;

  /** 写回剪贴板并尝试自动粘贴 */
  pasteEntry(payload: EntryIdPayload): Promise<IpcEnvelope<PasteResult>>;

  /** 读设置 */
  getSettings(): Promise<IpcEnvelope<Settings>>;

  /** 改设置（返回逐字段校验后的结果） */
  updateSettings(seed: SettingsSeedInput): Promise<IpcEnvelope<Settings>>;

  /** 订阅「条目已变化」；返回取消订阅函数 */
  onEntriesChanged(listener: () => void): () => void;

  /** 订阅「采集状态变化」（暂停/恢复、请求打开设置）；返回取消订阅函数 */
  onWatcherState(listener: (state: WatcherStatePayload) => void): () => void;
}

/** 渲染层可见的统一返回信封 */
export type IpcEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };

/** 撤销删除的入参 */
export interface EntryRestorePayload {
  entry: ClipEntryDetail;
}

/** 设置更新入参：只允许改这些字段，version 由主进程掌管 */
export interface SettingsSeedInput {
  retentionDays?: number;
  dedupWindowMs?: number;
  paused?: boolean;
  alwaysOnTop?: boolean;
  opacity?: number;
  windowBounds?: WindowBounds;
}

/** 主进程推送给渲染层的采集状态 */
export interface WatcherStatePayload {
  paused?: boolean;
  /** 请求界面打开设置面板（托盘菜单触发） */
  openSettings?: boolean;
}

