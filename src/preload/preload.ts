/**
 * 预加载脚本源码（构建时打包为自包含的 preload.js）。
 *
 * 为什么不能直接由 tsc 编译使用：`sandbox: true` 下的 preload 运行在受限环境里，
 * 其 `require` 只支持 electron 与少数内置模块，**无法加载相对路径的模块**
 * （实测报 `Error: module not found: ../shared/constants`）。因此本文件被
 * `scripts/build-preload.mjs` 打包成单文件，把 imported 的常量内联进去。
 *
 * 纪律（见 docs/编码规范.md §6 与 docs/技术方案.md §3）：
 * - 只暴露白名单方法，绝不暴露 ipcRenderer 原始对象、require、process。
 * - 所有入参在主进程侧仍需校验，渲染层数据不可信。
 *
 * 本阶段（Phase 1）只暴露一条连通性自检；真实能力在 Phase 4 按 IPC 契约接入。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_INVOKE, RENDERER_API_KEY } from '../shared/constants';
import type { ClipHistoryApi } from '../shared/types';

const api: ClipHistoryApi = {
  // 骨架期占位：sandbox 下的 preload 没有 process.env 可用，故不在此处读取版本号。
  // Phase 4 接入 IPC 层后，改为经主进程 app.getVersion() 返回真实版本。
  appVersion: '0.1.0',

  ping: () => ipcRenderer.invoke(IPC_INVOKE.appPing) as Promise<{ ok: boolean; message: string }>,
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, api);
