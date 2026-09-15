/**
 * 渲染层全局声明。
 *
 * `window.clipHistory` 由 preload 经 contextBridge 注入（见 src/preload/preload.ts）。
 * 没有这段声明，渲染层就看不到该 API，容易被误改成直接调用 Node —— 那会破坏
 * contextIsolation 与 sandbox 的安全边界（见 docs/技术方案.md §3）。
 *
 * 这里刻意不 import 任何模块（含共享类型），以保持它是「纯环境声明文件」：
 * 不产生运行时代码，也就不会在 dist 里留下空模块。
 */
interface ClipHistoryBridge {
  /** 应用版本号，用于界面展示与排查 */
  readonly appVersion: string;
  /** 骨架期的连通性自检，确认 IPC 通路可用 */
  ping(): Promise<{ ok: boolean; message: string }>;
}

interface Window {
  readonly clipHistory: ClipHistoryBridge;
}
