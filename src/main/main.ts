/**
 * 主进程入口：应用生命周期、单实例锁、窗口创建。
 *
 * 职责边界：不参与 DOM 渲染（见 docs/技术方案.md §3）。
 * 本阶段（Phase 1）只做最小可运行骨架：一个窗口 + 一条 IPC 自检通道。
 * 剪贴板采集、存储、托盘、真实 IPC 层分别在 Phase 3 / Phase 2 / Phase 4 接入。
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import {
  APP_ID,
  DEFAULT_WINDOW_BOUNDS,
  DEV_SERVER_ENV_KEY,
  IPC_INVOKE,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
} from '../shared/constants';

/** 主窗口引用；关闭后置空，以便再次唤起时重建 */
let mainWindow: BrowserWindow | null = null;

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
      .executeJavaScript('typeof window.clipHistory?.ping === "function"')
      .then((bridgeReady: unknown) => {
        clearTimeout(timeout);
        if (bridgeReady === true) {
          console.log('冒烟自检通过：窗口已加载，且 preload 已注入 IPC 通路');
          app.exit(0);
        } else {
          console.error('冒烟自检失败：窗口已加载，但 window.clipHistory.ping 不可用');
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
 * 骨架期自检通道：确认「渲染层 → preload → 主进程」通路可用。
 * 返回结果不含任何剪贴板内容（见 docs/编码规范.md §6 隐私要求）。
 */
function registerDiagnosticHandlers(): void {
  ipcMain.handle(IPC_INVOKE.appPing, () => ({
    ok: true,
    message: `主进程已就绪（Electron ${process.versions.electron}）`,
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
