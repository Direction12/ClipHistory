/**
 * 主进程入口：应用生命周期、单实例锁、窗口创建。
 *
 * 职责边界：不参与 DOM 渲染（见 docs/技术方案.md §3）。
 * 本阶段（Phase 1）只做最小可运行骨架：一个窗口 + 一条 IPC 自检通道。
 * 剪贴板采集、存储、托盘、真实 IPC 层分别在 Phase 3 / Phase 2 / Phase 4 接入。
 */

import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
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
import { ClipboardWatcher, createElectronClipboardSource } from './clipboard-watcher';
import { CleanupScheduler } from './cleanup';
import { ensureDataDirs, resolveDataPaths, type DataPaths } from './paths';
import { loadSettings } from './settings';
import { ClipStore } from './store';

/** 主窗口引用；关闭后置空，以便再次唤起时重建 */
let mainWindow: BrowserWindow | null = null;

/** 数据路径与存储层；在 app ready 后初始化 */
let dataPaths: DataPaths | null = null;
let store: ClipStore | null = null;

/** 采集器与清理器；初始化失败时为 null，界面仍需可用（只读历史） */
let watcher: ClipboardWatcher | null = null;
let cleanupScheduler: CleanupScheduler | null = null;

/** 记录采集过程中的异常，供诊断接口暴露 */
let lastWatcherError: string | null = null;

/**
 * 开发模式下由环境变量指定 Vite dev server 地址；未设置则加载本地构建产物。
 * 注意：`npm run dev` 默认走本地文件（build 后启动），保证「能启动」不依赖 dev server。
 */
/**
 * 冒烟自检开关。设置后应用会自行验证「渲染层已加载」并退出，
 * 供无图形界面的环境（CI、自动化验收）确认应用真能启动。
 *
 * 出现时机：脚本用它做启动自检；正常使用时不设置该变量，行为不受影响。
 */
const SMOKE_TEST_ENV_KEY = 'CLIPHISTORY_SMOKE_TEST';

/** 冒烟自检的兜底超时：超时即视为失败并返回非零退出码 */
const SMOKE_TEST_TIMEOUT_MS = 15_000;

function resolveRendererTarget(): { kind: 'url' | 'file'; value: string } {
  const devServer = process.env[DEV_SERVER_ENV_KEY];
  if (devServer && devServer.trim() !== '') {
    return { kind: 'url', value: devServer.trim() };
  }
  // dist/main/main.js → ../renderer/renderer/index.html
  // 为什么是 renderer/renderer：渲染层用 tsconfig.renderer-build.json 编译，
  // 其 rootDir=src、outDir=dist/renderer，故 src/renderer/index.html 对应
  // dist/renderer/renderer/index.html（与编译出的 main.js 同级）。
  return { kind: 'file', value: join(__dirname, '..', 'renderer', 'renderer', 'index.html') };
}

function createMainWindow(): void {
  const preloadPath = join(__dirname, '..', 'preload', 'preload.js');
  const target = resolveRendererTarget();

  mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_BOUNDS.width,
    height: DEFAULT_WINDOW_BOUNDS.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#FFF5F7',
    title: '历史粘贴',
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
  if (process.env[SMOKE_TEST_ENV_KEY] !== undefined) {
    mainWindow.webContents.on('console-message', (event) => {
      console.log(`[渲染层/preload 控制台] ${event.message}（${event.sourceId}:${event.lineNumber}）`);
    });
    mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`preload 执行出错：${preloadPath} —— ${error.message}`);
    });
  }

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
 * 供冒烟自检与将来的「关于/诊断」面板使用。
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
  ];
  if (lastWatcherError !== null) {
    parts.push(`最近采集错误 ${lastWatcherError}`);
  }
  return parts.join(' · ');
}

function focusOrCreateWindow(): void {
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

/**
 * 冒烟自检：等渲染层真的加载完成后打印一行结论并退出。
 * 用途见 SMOKE_TEST_ENV_KEY 的说明；不写入任何用户数据。
 */
function runSmokeTestIfRequested(): void {
  if (process.env[SMOKE_TEST_ENV_KEY] === undefined || mainWindow === null) {
    return;
  }

  const window = mainWindow;
  const timeout = setTimeout(() => {
    console.error('冒烟自检失败：15s 内未收到渲染层加载完成事件');
    app.exit(1);
  }, SMOKE_TEST_TIMEOUT_MS);

  window.webContents.once('did-finish-load', () => {
    void window.webContents
      .executeJavaScript('window.clipHistory?.ping?.()')
      .then((pingResult: unknown) => {
        clearTimeout(timeout);
        const result = pingResult as { ok?: boolean; message?: string } | undefined;
        if (result?.ok === true) {
          console.log(`冒烟自检通过：窗口已加载，preload 通路可用 —— ${String(result.message)}`);
          app.exit(0);
        } else {
          console.error('冒烟自检失败：窗口已加载，但主进程自检未返回 ok');
          app.exit(1);
        }
      })
      .catch((error: unknown) => {
        clearTimeout(timeout);
        console.error(`冒烟自检失败：脚本求值出错 —— ${String(error)}`);
        app.exit(1);
      });
  });

  window.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
    clearTimeout(timeout);
    console.error(`冒烟自检失败：渲染层加载失败（${errorCode} ${errorDescription}）`);
    app.exit(1);
  });
}

/**
 * 骨架期自检通道：确认「渲染层 → preload → 主进程」通路可用，
 * 并顺带暴露存储层与采集器的状态计数。
 * 返回结果不含任何剪贴板内容（见 docs/编码规范.md §6 隐私要求）。
 */
function registerDiagnosticHandlers(): void {
  ipcMain.handle(IPC_INVOKE.appPing, () => ({
    ok: true,
    message: buildHealthString(),
  }));
}

// 单实例锁：第二次启动时唤起已有实例，不重复常驻（见 docs/需求规格说明书.md FR-14）
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusOrCreateWindow();
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    initializeStorageAndWatcher();
    registerDiagnosticHandlers();
    createMainWindow();
    runSmokeTestIfRequested();

    // macOS 习惯：点击 Dock 图标且无窗口时重建窗口（本项目以 Windows 为主，保留兼容）
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    // Phase 4 接入托盘后，此行为会改为「隐藏到托盘不退出」。
    // 当前阶段无托盘，故按平台惯例退出，避免留下无窗口的僵尸进程。
    app.quit();
  });
}
