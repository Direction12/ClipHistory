/**
 * 渲染层全局声明。
 *
 * `window.clipHistory` 由 preload 经 contextBridge 注入（见 src/preload/preload.ts）。
 * 没有这段声明，渲染层就看不到该 API，容易被误改成直接调用 Node —— 那会破坏
 * contextIsolation 与 sandbox 的安全边界（见 docs/技术方案.md §3）。
 *
 * 为什么这里不复用 src/shared/types.ts：本文件是**纯环境声明**，不 import 任何模块，
 * 因此不产生运行时代码（tsc 的输出里不会多出一个空模块）。真源仍是 shared/types.ts，
 * 若那边改了契约，这里必须同步 —— 契约变更在 docs/技术方案.md §5 有登记。
 */

type ClipKind = 'text' | 'image';
type ClipFilter = 'all' | ClipKind;

interface ClipImageMeta {
  file: string;
  width: number;
  height: number;
  sizeBytes: number;
}

interface ClipEntryMeta {
  id: string;
  kind: ClipKind;
  hash: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  textPreview?: string;
  truncated?: boolean;
  /** 全文文件是否仍在；false 表示已丢失 */
  textAvailable?: boolean;
  /** 图片文件是否仍在；false 表示已丢失 */
  imageAvailable?: boolean;
  image?: ClipImageMeta;
}

interface ClipEntryDetail extends ClipEntryMeta {
  text?: string;
}

interface ClipSettings {
  version: number;
  retentionDays: number;
  dedupWindowMs: number;
  paused: boolean;
  /** 窗口置顶（始终显示在最前） */
  alwaysOnTop: boolean;
  /** 窗口透明度 0.4–1 */
  opacity: number;
  windowBounds: { x: number; y: number; width: number; height: number };
}

interface ClipDiagnostics {
  entries: number;
  text: number;
  image: number;
  pinned: number;
  damagedLines: number;
  paused: boolean;
  watcherRunning: boolean;
  cleanupRunning: boolean;
  dataRoot: string;
}

interface ClipPasteResult {
  ok: boolean;
  autoPasted: boolean;
  notice?: string;
  error?: string;
}

/** 统一的 IPC 返回信封：渲染层只需判断 ok */
type ClipEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };

interface ClipHistoryBridge {
  ping(): Promise<ClipEnvelope<{ ok: boolean; message: string }>>;
  diagnostics(): Promise<ClipEnvelope<ClipDiagnostics>>;
  listEntries(payload?: { query?: string; kind?: ClipFilter }): Promise<ClipEnvelope<ClipEntryMeta[]>>;
  getEntry(payload: { id: string }): Promise<ClipEnvelope<ClipEntryDetail | null>>;
  setPinned(payload: { id: string; pinned: boolean }): Promise<ClipEnvelope<ClipEntryMeta | null>>;
  deleteEntry(payload: { id: string }): Promise<ClipEnvelope<boolean>>;
  restoreEntry(payload: { entry: ClipEntryDetail }): Promise<ClipEnvelope<ClipEntryMeta>>;
  clearEntries(): Promise<ClipEnvelope<{ removed: number }>>;
  copyEntry(payload: { id: string }): Promise<ClipEnvelope<{ ok: boolean; error?: string }>>;
  pasteEntry(payload: { id: string }): Promise<ClipEnvelope<ClipPasteResult>>;
  getSettings(): Promise<ClipEnvelope<ClipSettings>>;
  updateSettings(seed: {
    retentionDays?: number;
    paused?: boolean;
    alwaysOnTop?: boolean;
    opacity?: number;
  }): Promise<ClipEnvelope<ClipSettings>>;
  onEntriesChanged(listener: () => void): () => void;
  onWatcherState(listener: (state: { paused?: boolean; openSettings?: boolean }) => void): () => void;
}

interface Window {
  readonly clipHistory: ClipHistoryBridge;
}
