/**
 * IPC 处理器：把渲染层的请求翻译成对 store / settings / watcher 的操作。
 *
 * 唯一真源：docs/技术方案.md §5（契约已在 Phase 4 冻结）。
 *
 * 设计要点：
 * - **依赖注入**：store、设置读写、watcher、清理器、诊断信息全部由外部传入，
 *   因此本模块不 import electron，可用 node:test 直接覆盖（含各种非法入参）。
 * - **入参一律视为不可信**：逐个字段校验类型与范围，非法即抛出带说明的错误。
 * - **失败一律抛异常**：由 `invokeSafely` 统一包成 `{ ok: false, error }`，
 *   渲染层只需判断 `ok`，不必区分两种失败风格（见契约纪律 2）。
 */

import { NOT_IMPLEMENTED_PREFIX } from '../shared/constants';
import type {
  ClipEntryDetail,
  ClipEntryMeta,
  DiagnosticsInfo,
  EntryFilter,
  PasteService,
  Settings,
} from '../shared/types';
import type { SettingsSeed } from './settings';
import type { ClipStore } from './store';

// ---------- 入参校验（纯函数，便于单测） ----------

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcValidationError';
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IpcValidationError(`${label} 必须是一个对象`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IpcValidationError(`${label} 必须是非空字符串`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new IpcValidationError(`${label} 必须是字符串`);
  }
  return value;
}

function optionalEntryFilter(value: unknown): EntryFilter | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== 'all' && value !== 'text' && value !== 'image') {
    throw new IpcValidationError('kind 只能是 all / text / image');
  }
  return value;
}

function requireNumericField(value: unknown, label: string, integerOnly: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new IpcValidationError(`${label} 必须是有限数字`);
  }
  if (integerOnly && !Number.isInteger(value)) {
    throw new IpcValidationError(`${label} 必须是整数`);
  }
  return value;
}

/**
 * 校验「撤销删除」送来的条目。
 *
 * 这一条来自渲染层，属于不可信输入，且会被直接写回索引，
 * 所以必需字段必须齐全且类型正确，否则宁可拒绝也不写坏数据。
 */
function requireEntryDetail(value: unknown): ClipEntryDetail {
  const record = requireRecord(value, 'entry');
  const id = requireNonEmptyString(record.id, 'entry.id');

  if (record.kind !== 'text' && record.kind !== 'image') {
    throw new IpcValidationError('entry.kind 只能是 text / image');
  }
  const hash = requireNonEmptyString(record.hash, 'entry.hash');
  const createdAt = requireNumericField(record.createdAt, 'entry.createdAt', true);
  const updatedAt = requireNumericField(record.updatedAt, 'entry.updatedAt', true);

  if (typeof record.pinned !== 'boolean') {
    throw new IpcValidationError('entry.pinned 必须是布尔值');
  }

  const detail: ClipEntryDetail = {
    id,
    kind: record.kind,
    hash,
    createdAt,
    updatedAt,
    pinned: record.pinned,
  };

  if (record.textPreview !== undefined) {
    detail.textPreview = requireNonEmptyString(record.textPreview, 'entry.textPreview');
  }
  if (record.truncated !== undefined) {
    if (typeof record.truncated !== 'boolean') {
      throw new IpcValidationError('entry.truncated 必须是布尔值');
    }
    detail.truncated = record.truncated;
  }
  if (record.text !== undefined) {
    detail.text = requireNonEmptyString(record.text, 'entry.text');
  }
  if (record.image !== undefined) {
    const image = requireRecord(record.image, 'entry.image');
    detail.image = {
      file: requireNonEmptyString(image.file, 'entry.image.file'),
      width: requireNumericField(image.width, 'entry.image.width', false),
      height: requireNumericField(image.height, 'entry.image.height', false),
      sizeBytes: requireNumericField(image.sizeBytes, 'entry.image.sizeBytes', false),
    };
  }

  return detail;
}

/**
 * 校验设置更新。
 *
 * 这里只做**结构**校验（对象形状与字段类型），范围与枚举交给
 * `settings.coerceSettings` 逐字段回退处理 —— 那是设置模块的唯一职责，
 * 重复实现一套范围判断只会造成两处规则不一致。
 */
export function validateSettingsSeed(value: unknown): SettingsSeed {
  const record = requireRecord(value, 'settings 更新内容');
  const seed: Record<string, unknown> = {};

  if (record.retentionDays !== undefined) {
    seed.retentionDays = requireNumericField(record.retentionDays, 'retentionDays', true);
  }
  if (record.dedupWindowMs !== undefined) {
    seed.dedupWindowMs = requireNumericField(record.dedupWindowMs, 'dedupWindowMs', true);
  }
  if (record.alwaysOnTop !== undefined) {
    if (typeof record.alwaysOnTop !== 'boolean') {
      throw new IpcValidationError('alwaysOnTop 必须是布尔值');
    }
    seed.alwaysOnTop = record.alwaysOnTop;
  }
  if (record.opacity !== undefined) {
    seed.opacity = requireNumericField(record.opacity, 'opacity', false);
  }
  if (record.paused !== undefined) {
    if (typeof record.paused !== 'boolean') {
      throw new IpcValidationError('paused 必须是布尔值');
    }
    seed.paused = record.paused;
  }
  if (record.windowBounds !== undefined) {
    const bounds = requireRecord(record.windowBounds, 'windowBounds');
    seed.windowBounds = {
      x: requireNumericField(bounds.x, 'windowBounds.x', false),
      y: requireNumericField(bounds.y, 'windowBounds.y', false),
      width: requireNumericField(bounds.width, 'windowBounds.width', false),
      height: requireNumericField(bounds.height, 'windowBounds.height', false),
    };
  }

  return seed as SettingsSeed;
}

// ---------- 处理器依赖与实现 ----------

export interface IpcDeps {
  readonly getStore: () => ClipStore | null;
  readonly readSettings: () => Settings;
  /** 更新设置并返回校验后的结果 */
  readonly updateSettings: (seed: SettingsSeed) => Settings;
  readonly setPaused: (paused: boolean) => void;
  readonly isPaused: () => boolean;
  readonly isWatcherRunning: () => boolean;
  readonly isCleanupRunning: () => boolean;
  readonly getDataRoot: () => string;
  /** 剪贴板写回能力；Phase 4 只支持文本（见契约纪律 5） */
  readonly paste: PasteService;
}

function requireStore(deps: IpcDeps): ClipStore {
  const store = deps.getStore();
  if (store === null) {
    throw new Error('存储层尚未就绪，请稍后重试');
  }
  return store;
}

/** 校验 id 存在，否则给出可行动的错误（渲染层据此提示并刷新列表） */
function requireExistingEntry(store: ClipStore, id: string): ClipEntryMeta {
  const meta = store.get(id);
  if (meta === null) {
    throw new Error('该条目可能已被删除，请刷新列表');
  }
  return meta;
}

/**
 * 通道实现表。键名与 `IPC_INVOKE` 的语义一一对应，
 * 由 `invokeSafely` 统一包装异常。
 */
export function createIpcHandlers(deps: IpcDeps): Record<string, (payload: unknown) => unknown> {
  return {
    listEntries: (payload: unknown): ClipEntryMeta[] => {
      const record = payload === undefined || payload === null ? {} : requireRecord(payload, '查询条件');
      const query = optionalString(record.query, 'query');
      const kind = optionalEntryFilter(record.kind);
      return requireStore(deps).list({ query, kind });
    },

    getEntry: (payload: unknown): ClipEntryDetail | null => {
      const record = requireRecord(payload, '查询条件');
      const id = requireNonEmptyString(record.id, 'id');
      return requireStore(deps).getDetail(id);
    },

    setPinned: (payload: unknown): ClipEntryMeta | null => {
      const record = requireRecord(payload, '入参');
      const id = requireNonEmptyString(record.id, 'id');
      if (typeof record.pinned !== 'boolean') {
        throw new IpcValidationError('pinned 必须是布尔值');
      }
      const store = requireStore(deps);
      requireExistingEntry(store, id);
      return store.setPinned(id, record.pinned);
    },

    deleteEntry: (payload: unknown): boolean => {
      const record = requireRecord(payload, '入参');
      const id = requireNonEmptyString(record.id, 'id');
      return requireStore(deps).remove(id);
    },

    restoreEntry: (payload: unknown): ClipEntryMeta => {
      const record = requireRecord(payload, '入参');
      const detail = requireEntryDetail(record.entry);
      return requireStore(deps).restore(detail);
    },

    clearEntries: (payload: unknown): { removed: number } => {
      const record = payload === undefined || payload === null ? {} : requireRecord(payload, '入参');
      // keepPinned 固定为 true：清空必须保留置顶（FR-15），不接受渲染层传其它值
      if (record.keepPinned !== undefined && record.keepPinned !== true) {
        throw new IpcValidationError('清空历史时 keepPinned 只能为 true（置顶条目必须保留）');
      }
      return requireStore(deps).clear(true);
    },

    copyEntry: async (payload: unknown) => {
      const record = requireRecord(payload, '入参');
      const id = requireNonEmptyString(record.id, 'id');
      requireExistingEntry(requireStore(deps), id);
      return deps.paste.writeEntryToClipboard(id);
    },

    pasteEntry: async (payload: unknown) => {
      const record = requireRecord(payload, '入参');
      const id = requireNonEmptyString(record.id, 'id');
      requireExistingEntry(requireStore(deps), id);
      return deps.paste.pasteEntryToActiveWindow(id);
    },

    getSettings: (): Settings => deps.readSettings(),

    updateSettings: (payload: unknown): Settings => {
      const seed = validateSettingsSeed(payload);
      const updated = deps.updateSettings(seed);
      // paused 由设置驱动；变化后要同步给采集器（否则暂停只是写进了文件）
      if (seed.paused !== undefined) {
        deps.setPaused(seed.paused);
      }
      return updated;
    },

    diagnostics: (): DiagnosticsInfo => {
      const stats = deps.getStore()?.stats();
      return {
        entries: stats?.entries ?? 0,
        text: stats?.text ?? 0,
        image: stats?.image ?? 0,
        pinned: stats?.pinned ?? 0,
        damagedLines: stats?.damagedLines ?? 0,
        paused: deps.isPaused(),
        watcherRunning: deps.isWatcherRunning(),
        cleanupRunning: deps.isCleanupRunning(),
        dataRoot: deps.getDataRoot(),
      };
    },
  };
}

/** 通道标识，与 `IPC_INVOKE` 的值对应 */
export type IpcHandlerName = keyof ReturnType<typeof createIpcHandlers>;

/**
 * 统一包装：任何抛出都变成 `{ ok: false, error }`，绝不把未处理异常丢回渲染层。
 * 成功时返回 `{ ok: true, data }`。
 */
export async function invokeSafely<T>(
  handler: (payload: unknown) => T | Promise<T>,
  payload: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const data = await handler(payload);
    return { ok: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

/** 尚未实现的通道统一回应（见契约纪律 5 与 §5.3） */
export async function notImplemented(feature: string): Promise<never> {
  throw new Error(`${NOT_IMPLEMENTED_PREFIX}：${feature}`);
}
