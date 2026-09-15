/**
 * 预加载脚本源码（构建时打包为自包含的 preload.js）。
 *
 * 为什么不能直接由 tsc 编译使用：`sandbox: true` 下的 preload 运行在受限环境里，
 * 其 `require` 只支持 electron 与少数内置模块，**无法加载相对路径的模块**
 * （实测报 `module not found: ../shared/constants`）。因此本文件被
 * `scripts/build-preload.mjs` 打包成单文件，把 imported 的常量内联进去。
 *
 * 纪律（见 docs/编码规范.md §6 与 docs/技术方案.md §3）：
 * - 只暴露白名单方法，绝不暴露 ipcRenderer 原始对象、require、process。
 * - 所有入参在主进程侧仍需校验，渲染层数据不可信。
 * - 事件订阅必须返回取消订阅函数，避免界面重建后重复监听。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC_EVENT, IPC_INVOKE, RENDERER_API_KEY } from '../shared/constants';
import type {
  ClearResult,
  ClipEntryDetail,
  ClipEntryMeta,
  ClipHistoryApi,
  DiagnosticsInfo,
  EntryIdPayload,
  EntryQueryPayload,
  EntryRestorePayload,
  IpcEnvelope,
  OperationResult,
  PasteResult,
  SetPinnedPayload,
  Settings,
  SettingsSeedInput,
  WatcherStatePayload,
} from '../shared/types';

/** 统一调用入口：主进程已把异常包成信封，这里原样透传 */
function invoke<T>(channel: string, payload?: unknown): Promise<IpcEnvelope<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcEnvelope<T>>;
}

const api: ClipHistoryApi = {
  ping: () => invoke<{ ok: boolean; message: string }>(IPC_INVOKE.appPing),

  diagnostics: () => invoke<DiagnosticsInfo>(IPC_INVOKE.appDiagnostics),

  listEntries: (payload: EntryQueryPayload = {}) =>
    invoke<ClipEntryMeta[]>(IPC_INVOKE.entriesList, payload),

  getEntry: (payload: EntryIdPayload) => invoke<ClipEntryDetail | null>(IPC_INVOKE.entriesGet, payload),

  setPinned: (payload: SetPinnedPayload) =>
    invoke<ClipEntryMeta | null>(IPC_INVOKE.entriesSetPinned, payload),

  deleteEntry: (payload: EntryIdPayload) => invoke<boolean>(IPC_INVOKE.entriesDelete, payload),

  restoreEntry: (payload: EntryRestorePayload) =>
    invoke<ClipEntryMeta>(IPC_INVOKE.entriesRestore, payload),

  clearEntries: () => invoke<ClearResult>(IPC_INVOKE.entriesClear, { keepPinned: true }),

  copyEntry: (payload: EntryIdPayload) =>
    invoke<OperationResult>(IPC_INVOKE.pasteCopy, payload),

  pasteEntry: (payload: EntryIdPayload) => invoke<PasteResult>(IPC_INVOKE.pasteToActive, payload),

  getSettings: () => invoke<Settings>(IPC_INVOKE.settingsGet),

  updateSettings: (seed: SettingsSeedInput) => invoke<Settings>(IPC_INVOKE.settingsUpdate, seed),

  onEntriesChanged: (listener: () => void) => {
    const handler = (): void => {
      listener();
    };
    ipcRenderer.on(IPC_EVENT.entriesChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT.entriesChanged, handler);
    };
  },

  onWatcherState: (listener: (state: WatcherStatePayload) => void) => {
    const handler = (_event: IpcRendererEvent, state: WatcherStatePayload): void => {
      listener(state);
    };
    ipcRenderer.on(IPC_EVENT.watcherState, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT.watcherState, handler);
    };
  },
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, api);
