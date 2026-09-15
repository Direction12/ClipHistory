/**
 * 主进程入口：应用生命周期、单实例锁、窗口管理、托盘、IPC 注册。
 *
 * 职责边界：不参与 DOM 渲染（见 docs/技术方案.md §3）。
 * 各阶段分工：存储层（Phase 2）、采集与清理（Phase 3）、窗口/托盘/IPC（Phase 4）。
 */

import { app, BrowserWindow, clipboard, ipcMain, protocol, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  APP_ID,
  DEFAULT_WINDOW_BOUNDS,
  DEV_SERVER_ENV_KEY,
  IPC_EVENT,
  IPC_INVOKE,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
} from '../shared/constants';
import type { Settings, WindowBounds } from '../shared/types';
import { ClipboardWatcher, createElectronClipboardSource } from './clipboard-watcher';
import { CleanupScheduler } from './cleanup';
import { createIpcHandlers, invokeSafely, type IpcDeps } from './ipc';
import { runCommand, sendPasteKeys, writePngToClipboard } from './native-clipboard';
import { activateWindow, findPreviousWindow } from './window-focus';
import { createPasteService, type ClipboardWriter } from './paste';
import { ensureDataDirs, resolveDataPaths, type DataPaths } from './paths';
import { loadSettings, updateSettings as persistSettings, type SettingsSeed } from './settings';
import { runIntegrationSmokeTest } from './smoke';
import { IMAGE_PROTOCOL, registerImageProtocol } from './thumbnails';
import { ClipStore } from './store';
import { createTray, type TrayHandle } from './tray';

/** 主窗口引用；关闭后置空，以便再次唤起时重建 */
let mainWindow: BrowserWindow | null = null;

/** 数据路径与存储层；在 app ready 后初始化 */
let dataPaths: DataPaths | null = null;
let store: ClipStore | null = null;

/** 采集器与清理器；初始化失败时为 null，界面仍需可用（只读历史） */
let watcher: ClipboardWatcher | null = null;
let cleanupScheduler: CleanupScheduler | null = null;
let trayHandle: TrayHandle | null = null;

/** 记录采集过程中的异常，供诊断接口暴露 */
let lastWatcherError: string | null = null;

/**
 * 声明 clipimg 为特权 scheme。
 *
 * **必须在 app ready 之前调用**，否则协议注册会失败。
 * 属性含义：standard（正常 URL 解析）/ secure（视为安全来源，
 * 能被 CSP 的 img-src 与 fetch 正常使用）/ supportFetchAPI / stream。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: IMAGE_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/**
 * 进程级兜底日志。
 *
 * 为什么必须放在 app ready 之前：如果初始化阶段就抛异常（例如模块加载失败），
 * 进程会静默退出、什么都不打印 —— 排查时完全看不出发生过什么。
 * 这三个钩子保证「任何未捕获的失败」至少留下一条线索。
 */
process.on('uncaughtException', (error) => {
  console.error(`[致命] 未捕获异常：${error.stack ?? error.message}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[致命] 未处理的 Promise 拒绝：${String(reason)}`);
});
process.on('exit', (code) => {
  if (isSmokeTest()) {
    console.error(`[自检] 进程退出，退出码 ${String(code)}`);
  }
});

/** 阻止「关窗即退出」，改由托盘菜单退出 */
let isQuitting = false;

/** 冒烟自检开关与超时（超时即视为失败并返回非零退出码） */
const SMOKE_TEST_ENV_KEY = 'CLIPHISTORY_SMOKE_TEST';
const SMOKE_TEST_TIMEOUT_MS = 30_000;

/** 是否在冒烟自检模式（会拦截退出路径） */
function isSmokeTest(): boolean {
  return process.env[SMOKE_TEST_ENV_KEY] !== undefined;
}

/** 资产目录：开发时在项目根，打包后在 resources 下 */
function resolveAssetsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'assets') : join(__dirname, '..', '..', 'assets');
}

// ---------- 设置读写 ----------

function currentPaths(): DataPaths {
  return dataPaths ?? resolveDataPaths();
}

function readCurrentSettings(): Settings {
  return loadSettings(currentPaths()).settings;
}

function applySettingsSeed(seed: SettingsSeed): Settings {
  const { settings, warnings } = persistSettings(seed, currentPaths());
  for (const warning of warnings) {
    console.warn(`设置告警：${warning}`);
  }
  return settings;
}

/**
 * 设置变更后通知渲染层重读。
 *
 * 为什么必须广播：设置会影响界面呈现（例如 pasteMode 决定卡片主按钮是「复制」还是「粘贴」），
 * 若不通知，用户改完设置得等下一次列表刷新才看到变化 —— 表现为「改了没反应」。
 * 渲染层收到后统一重读设置（见 src/renderer/main.ts 的 onWatcherState）。
 */
function notifySettingsChanged(): void {
  mainWindow?.webContents.send(IPC_EVENT.watcherState, { settingsChanged: true });
}

/**
 * 用户主动改设置的入口：写入后广播给渲染层刷新。
 *
 * 与 `applySettingsSeed` 的区别：后者还会被主进程内部调用（例如保存窗口位置），
 * 那类改动不需要惊动界面，故只在用户路径上广播。
 */
function applyUserSettingsSeed(seed: SettingsSeed): Settings {
  const settings = applySettingsSeed(seed);
  // 立即把窗口层面的设置应用到实际窗口（置顶 / 透明度），否则要重启才生效
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    if (seed.alwaysOnTop !== undefined) {
      mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
    }
    if (seed.opacity !== undefined) {
      mainWindow.setOpacity(settings.opacity);
    }
  }
  notifySettingsChanged();
  return settings;
}


/**
 * 开发模式下由环境变量指定 Vite dev server 地址；未设置则加载本地构建产物。
 * 注意：`npm run dev` 默认走本地文件（build 后启动），保证「能启动」不依赖 dev server。
 */
function resolveRendererTarget(): { kind: 'url' | 'file'; value: string } {
  const devServer = process.env[DEV_SERVER_ENV_KEY];
  if (devServer && devServer.trim() !== '') {
    return { kind: 'url', value: devServer.trim() };
  }
  // dist/main/main.js → ../renderer/renderer/index.html
  // 为什么是 renderer/renderer：见 docs/技术方案.md C-02。
  return { kind: 'file', value: join(__dirname, '..', 'renderer', 'renderer', 'index.html') };
}

/** 读取记忆的窗口位置；非法或缺失则回退默认值 */
function resolveInitialBounds(): WindowBounds {
  const { windowBounds } = readCurrentSettings();
  return {
    x: windowBounds.x ?? DEFAULT_WINDOW_BOUNDS.x,
    y: windowBounds.y ?? DEFAULT_WINDOW_BOUNDS.y,
    width: windowBounds.width > 0 ? windowBounds.width : DEFAULT_WINDOW_BOUNDS.width,
    height: windowBounds.height > 0 ? windowBounds.height : DEFAULT_WINDOW_BOUNDS.height,
  };
}

/** 把窗口位置写回设置；写入失败不应影响使用 */
function persistWindowBounds(): void {
  if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.isMinimized()) {
    return;
  }
  try {
    applySettingsSeed({ windowBounds: mainWindow.getBounds() });
  } catch (error) {
    console.warn(`保存窗口位置失败：${String(error)}`);
  }
}

function createMainWindow(): void {
  const preloadPath = join(__dirname, '..', 'preload', 'preload.js');
  const target = resolveRendererTarget();
  const bounds = resolveInitialBounds();
  const settingsForWindow = readCurrentSettings();

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#FFF5F7',
    title: '历史粘贴',
    // 置顶与透明度来自设置（FR-13a / FR-13b）
    alwaysOnTop: settingsForWindow.alwaysOnTop,
    opacity: settingsForWindow.opacity,
    webPreferences: {
      // 安全配置固定，不得放宽（见 docs/技术方案.md §3 与 CLAUDE.md §5.4）
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 首帧就绪后再显示，避免白屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // 冒烟自检时把渲染层与 preload 的控制台输出透出来，否则 preload 报错会被静默吞掉
  if (isSmokeTest()) {
    mainWindow.webContents.on('console-message', (event) => {
      console.log(`[渲染层/preload 控制台] ${event.message}（${event.sourceId}:${event.lineNumber}）`);
    });
    mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`preload 执行出错：${preloadPath} —— ${error.message}`);
    });
  }

  // 关闭窗口 = 隐藏到托盘，不退出（FR-07）；只有托盘「退出」才真正结束进程。
  // 自检模式下不拦截，否则进程无法自行结束。
  mainWindow.on('close', (event) => {
    if (isQuitting || isSmokeTest()) {
      return;
    }
    event.preventDefault();
    persistWindowBounds();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外部链接交给系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (target.kind === 'url') {
    void mainWindow.loadURL(target.value);
  } else {
    void mainWindow.loadFile(target.value);
  }
}

/** 唤起已有窗口；不存在则重建 */
function showMainWindow(): void {
  if (mainWindow === null) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function focusOrCreateWindow(): void {
  showMainWindow();
}

/**
 * 初始化存储层与采集器。任何一步失败都只记录并降级，不让应用起不来。
 *
 * 顺序有讲究：先建 store（历史可读），再起 watcher（开始记录），
 * 最后由 CleanupScheduler.start() 立刻做一次启动清理。
 */
function initializeStorageAndWatcher(): void {
  try {
    dataPaths = resolveDataPaths();
    ensureDataDirs(dataPaths);

    const currentStore = new ClipStore({ paths: dataPaths });
    currentStore.init();
    store = currentStore;

    // 去重窗口与期限都由设置驱动；每次采集时重新读取，保证改设置立即生效
    currentStore.setDedupWindowProvider(() => {
      const { settings } = loadSettings(dataPaths ?? resolveDataPaths());
      return settings.dedupWindowMs;
    });

    const currentWatcher = new ClipboardWatcher({
      source: createElectronClipboardSource(clipboard),
      onError: (error) => {
        lastWatcherError = error instanceof Error ? error.message : String(error);
      },
      onCapture: (captured) => {
        handleCapture(captured);
      },
    });

    // 启动时不采集剪贴板里已有的陈旧内容（见 docs/技术方案.md D-09）。
    // 剪贴板读取是异步的，故先建基线再开轮询，避免首轮把旧内容记进来。
    void currentWatcher
      .primeBaseline()
      .catch((error: unknown) => {
        lastWatcherError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        currentWatcher.start();
      });
    watcher = currentWatcher;

    const scheduler = new CleanupScheduler({
      store: currentStore,
      getSettings: () => loadSettings(dataPaths ?? resolveDataPaths()).settings,
    });
    scheduler.start();
    cleanupScheduler = scheduler;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`存储层/采集器初始化失败，应用将以只读状态运行：${reason}`);
  }
}

/** 把一条采集结果写入 store，并通知渲染层刷新 */
function handleCapture(captured: {
  kind: 'text' | 'image';
  text: string;
  imagePngBytes: Buffer | null;
  imageWidth: number;
  imageHeight: number;
}): void {
  if (store === null) {
    return;
  }

  if (captured.kind === 'image' && captured.imagePngBytes !== null) {
    store.addImage(captured.imagePngBytes, captured.imageWidth, captured.imageHeight);
  } else {
    store.addText(captured.text);
  }

  // 日志只记类型与长度，绝不记录剪贴板原文（见 CLAUDE.md §5.6）
  const size = captured.kind === 'image' ? (captured.imagePngBytes?.length ?? 0) : captured.text.length;
  console.log(`已记录一条${captured.kind === 'image' ? '图片' : '文本'}内容（长度 ${String(size)}）`);

  mainWindow?.webContents.send(IPC_EVENT.entriesChanged);
}

/**
 * 诊断信息：只含计数与状态，**不含任何剪贴板内容**。
 * 供诊断接口与「关于」面板使用。
 */
function buildHealthString(): string {
  const stats = store?.stats();
  const parts = [
    '存储就绪',
    `Electron ${process.versions.electron}`,
    `条目 ${String(stats?.entries ?? 0)}`,
    `采集${watcher?.isPaused === true ? '已暂停' : '运行中'}`,
    watcher?.isRunning === true ? '轮询开' : '轮询关',
    cleanupScheduler?.isRunning === true ? '清理开' : '清理关',
    trayHandle === null ? '托盘未就绪' : '托盘就绪',
  ];
  if (lastWatcherError !== null) {
    parts.push(`最近采集错误 ${lastWatcherError}`);
  }
  return parts.join(' · ');
}

// ---------- IPC ----------

function notifyEntriesChanged(): void {
  mainWindow?.webContents.send(IPC_EVENT.entriesChanged);
}

/** 同步暂停状态到采集器、托盘与界面（三处必须一致，否则用户会看到矛盾状态） */
function applyPausedState(paused: boolean): void {
  watcher?.setPaused(paused);
  trayHandle?.setPaused(paused);
  mainWindow?.webContents.send(IPC_EVENT.watcherState, { paused });
}

function buildIpcDeps(): IpcDeps {
  const nativeOptions = { run: runCommand };

  const clipboardWriter: ClipboardWriter = {
    writeText: (text: string) => clipboard.writeText(text),
    // 图片必须走 Windows 原生剪贴板：Electron 的 write() 对图片会「成功但没写进去」（见 C-05）
    writeImagePng: (pngBytes: Buffer) => writePngToClipboard(pngBytes, nativeOptions),
  };

  const paste = createPasteService({
    store: {
      // paste 只需要「按 id 取详情」这一项能力，故只注入这个函数而非整个 store
      getDetail: (id: string) => store?.getDetail(id) ?? null,
    },
    clipboard: clipboardWriter,
    readImageBytes: async (relativePath: string) => {
      const currentStore = store;
      if (currentStore === null) {
        return null;
      }
      // 复用 store 的路径校验（拒绝越界路径），避免这里成为绕过点
      const absolute = currentStore.imageAbsolutePathFromRelative(relativePath);
      if (absolute === null) {
        return null;
      }
      try {
        return await readFile(absolute);
      } catch {
        return null;
      }
    },
    sendPasteKeys: () => sendPasteKeys(nativeOptions),
    hideAppWindow: async () => {
      // 隐藏本窗口，让焦点有机会回落到用户原本的程序
      mainWindow?.hide();
    },
    restoreFocusToPreviousWindow: async () => {
      // 关键：隐藏窗口并不会让焦点自动回到用户原本的程序（实测会停在上一个其它窗口上，
      // 例如浏览器），必须显式切回，否则按键会静默打到错误的窗口（见技术方案 C-14）。
      const target = await findPreviousWindow(process.pid, { run: runCommand });
      if (target === null) {
        return { ok: false, error: '未能找到可粘贴的目标窗口' };
      }
      const activated = await activateWindow(target, { run: runCommand });
      return activated.ok ? { ok: true } : { ok: false, error: activated.detail };
    },
    showAppWindow: () => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    },
    onSelfWrite: () => {
      watcher?.markSelfWrite();
    },
    wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  return {
    getStore: () => store,
    readSettings: readCurrentSettings,
    updateSettings: applyUserSettingsSeed,
    setPaused: applyPausedState,
    isPaused: () => watcher?.isPaused ?? readCurrentSettings().paused,
    isWatcherRunning: () => watcher?.isRunning ?? false,
    isCleanupRunning: () => cleanupScheduler?.isRunning ?? false,
    getDataRoot: () => currentPaths().root,
    paste,
  };
}

function registerIpcHandlers(): void {
  const handlers = createIpcHandlers(buildIpcDeps());

  const routes: Array<[string, keyof typeof handlers]> = [
    [IPC_INVOKE.entriesList, 'listEntries'],
    [IPC_INVOKE.entriesGet, 'getEntry'],
    [IPC_INVOKE.entriesSetPinned, 'setPinned'],
    [IPC_INVOKE.entriesDelete, 'deleteEntry'],
    [IPC_INVOKE.entriesRestore, 'restoreEntry'],
    [IPC_INVOKE.entriesClear, 'clearEntries'],
    [IPC_INVOKE.pasteCopy, 'copyEntry'],
    [IPC_INVOKE.pasteToActive, 'pasteEntry'],
    [IPC_INVOKE.settingsGet, 'getSettings'],
    [IPC_INVOKE.settingsUpdate, 'updateSettings'],
    [IPC_INVOKE.appDiagnostics, 'diagnostics'],
  ];

  for (const [channel, handlerName] of routes) {
    const handler = handlers[handlerName] as (input: unknown) => unknown;
    ipcMain.handle(channel, async (_event, payload: unknown) => invokeSafely(handler, payload));
  }

  // 兼容通道：只回答「主进程是否活着」与健康串，供快速自检
  ipcMain.handle(IPC_INVOKE.appPing, async () =>
    invokeSafely(() => ({ ok: true, message: buildHealthString() }), undefined),
  );
}

// ---------- 托盘 ----------

function initializeTray(): void {
  trayHandle = createTray(resolveAssetsDir(), () => watcher?.isPaused ?? false, {
    showWindow: showMainWindow,
    togglePause: (paused: boolean) => {
      applySettingsSeed({ paused });
      applyPausedState(paused);
    },
    clearHistory: () => {
      const { removed } = store?.clear(true) ?? { removed: 0 };
      console.log(`托盘清空历史：移除 ${String(removed)} 条（置顶已保留）`);
      notifyEntriesChanged();
    },
    openSettings: () => {
      showMainWindow();
      mainWindow?.webContents.send(IPC_EVENT.watcherState, { openSettings: true });
    },
    quit: () => {
      isQuitting = true;
      app.quit();
    },
  });

  if (trayHandle === null) {
    console.warn(`托盘图标未能创建（${join(resolveAssetsDir(), 'icon.png')} 不存在或不可读）`);
  }
}

// ---------- 冒烟自检 ----------

/**
 * 冒烟自检：等渲染层加载完成后，先校验 preload 通路，再驱动真实 IPC 处理器走完整流程。
 *
 * 为什么不等用户点击：图形界面无法在自动化环境里肉眼确认，
 * 但「IPC 处理器能否正确读写真实 store」可以在无界面下完整验证（详见 src/main/smoke.ts）。
 * 自检会写入数据，故运行时由 scripts/run-electron.mjs 把数据目录指向临时目录。
 */
function runSmokeTestIfRequested(): void {
  if (!isSmokeTest()) {
    return;
  }
  console.log('[自检] 已请求冒烟自检');

  if (mainWindow === null) {
    console.error('冒烟自检失败：主窗口未创建');
    app.exit(1);
    return;
  }

  const window = mainWindow;
  const timeout = setTimeout(() => {
    console.error('冒烟自检失败：30s 内未完成');
    app.exit(1);
  }, SMOKE_TEST_TIMEOUT_MS);

  console.log(`[自检] 等待渲染层加载：${window.webContents.getURL() || '(尚未开始加载)'}`);

  window.webContents.on('did-finish-load', () => {
    console.log('[自检] 渲染层加载完成事件已触发');
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[自检] 渲染层加载失败：${String(errorCode)} ${errorDescription}（${validatedURL}）`);
  });

  window.webContents.once('did-finish-load', () => {
    console.log('[自检] 开始执行自检流程');
    void (async () => {
      try {
        const pingResult = (await window.webContents.executeJavaScript(
          'window.clipHistory?.ping?.()',
        )) as { ok?: boolean; data?: { ok?: boolean; message?: string } } | undefined;

        if (pingResult?.ok !== true || pingResult.data?.ok !== true) {
          throw new Error('preload 通路不可用：window.clipHistory.ping 未返回预期结果');
        }
        console.log(`冒烟自检：窗口已加载，preload 通路可用 —— ${String(pingResult.data.message)}`);

        if (store === null || watcher === null) {
          throw new Error('存储层或采集器未初始化，无法进行集成自检');
        }

        const result = await runIntegrationSmokeTest({
          store,
          watcher,
          deps: buildIpcDeps(),
          log: (line: string) => {
            console.log(line);
          },
          evaluateInRenderer: (expression: string) =>
            window.webContents.executeJavaScript(expression) as Promise<unknown>,
          layoutProbe: async () => {
            // 缩到最小宽度后核对真实布局：这是「360px 下不横向滚动」唯一的实证方式
            if (mainWindow === null || mainWindow.isDestroyed()) {
              return { ok: false, detail: '窗口不存在' };
            }
            const original = mainWindow.getBounds();
            mainWindow.setBounds({ ...original, width: MIN_WINDOW_WIDTH });
            await new Promise((resolve) => setTimeout(resolve, 250));

            const measured = (await mainWindow.webContents.executeJavaScript(
              '({ w: document.documentElement.clientWidth, scrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth })',
            )) as { w: number; scrollW: number; bodyScrollW: number };

            mainWindow.setBounds(original);
            await new Promise((resolve) => setTimeout(resolve, 150));

            const overflow = Math.max(measured.scrollW, measured.bodyScrollW) - measured.w;
            return {
              ok: overflow <= 2,
              detail: `最小宽度 ${String(measured.w)}px，内容宽 ${String(Math.max(measured.scrollW, measured.bodyScrollW))}px`,
            };
          },
          focusProbe: async () => {
            // 让本窗口先退到后面，再验证「能否把焦点切回上一个窗口」。
            // 这是自动粘贴的核心机制：切不回去，按键就会打进错误的窗口（C-14）。
            if (mainWindow !== null && !mainWindow.isDestroyed()) {
              mainWindow.blur();
            }
            const target = await findPreviousWindow(process.pid, { run: runCommand });
            if (target === null) {
              return { ok: false, detail: '未能找到可切回的目标窗口' };
            }
            const activated = await activateWindow(target, { run: runCommand });
            return {
              ok: activated.ok,
              detail: activated.ok ? `已切回 ${target.className}` : activated.detail,
            };
          },
        });

        console.log('');
        if (result.failed.length > 0) {
          console.error(`集成自检失败 ${String(result.failed.length)} 项：`);
          for (const failure of result.failed) {
            console.error(`  - ${failure}`);
          }
          app.exit(1);
          return;
        }

        console.log(`集成自检通过：${String(result.passed)} 项断言全部符合预期`);
        console.log(`健康状态：${buildHealthString()}`);
        app.exit(0);
      } catch (error) {
        console.error(`冒烟自检失败：${error instanceof Error ? error.stack : String(error)}`);
        app.exit(1);
      } finally {
        clearTimeout(timeout);
      }
    })();
  });
}

// ---------- 启动 ----------

// 单实例锁：第二次启动时唤起已有实例，不重复常驻（见 docs/需求规格说明书.md FR-14）。
//
// 为什么自检模式跳过它：自检会反复运行，一旦上一次自检留下残留进程占着锁，
// 本次启动就会**立刻退出且不打印任何日志**（退出码还是 0），极难排查 —— 本项目真实踩过。
// 自检本就运行在独立的临时数据目录，跳过锁是安全的。
const gotSingleInstanceLock = isSmokeTest() ? true : app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  console.error('已有实例在运行，本次启动退出（如需强制启动，请先结束残留进程）');
  app.quit();
} else {
  app.on('second-instance', () => {
    focusOrCreateWindow();
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    initializeStorageAndWatcher();
    // 缩略图协议：让渲染层能安全地显示真实图片（见 src/main/thumbnails.ts）
    if (dataPaths !== null) {
      registerImageProtocol({ paths: dataPaths });
    }
    initializeTray();
    registerIpcHandlers();
    createMainWindow();

    // 启动时把上次的暂停状态同步给托盘（否则托盘勾选与实际记录状态不符）
    const settingsAtStartup = readCurrentSettings();
    applyPausedState(settingsAtStartup.paused);

    runSmokeTestIfRequested();

    // macOS 习惯：点击 Dock 图标且无窗口时重建窗口（本项目以 Windows 为主，保留兼容）
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    // 关窗只是隐藏到托盘（FR-07），因此这里**不**退出应用；
    // 只有托盘「退出」或冒烟自检才允许结束进程。
    if (isQuitting || isSmokeTest()) {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    persistWindowBounds();
    watcher?.stop();
    cleanupScheduler?.stop();
    trayHandle?.destroy();
  });
}
