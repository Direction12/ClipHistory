/**
 * 集成冒烟自检：在**无人点击界面**的情况下，驱动真实 IPC 处理器走完整流程。
 *
 * 为什么需要它：图形界面无法在自动化环境里肉眼确认，但「IPC 处理器能否正确读写真实
 * store」是可以在无界面下验证的。这里用采集器的测试接缝注入可控内容，然后依次调用
 * 与界面完全相同的处理器：采集 → 列表 → 搜索 → 筛选 → 置顶 → 详情 → 删除 → 撤销
 * → 设置读写 → 非法入参拒绝 → 诊断 → 清空（保留置顶）。
 *
 * 安全：自检会写入数据，因此调用方必须把数据目录指向临时目录
 * （见 scripts/run-electron.mjs 与 docs/构建与运行.md §4）。
 */

import { createIpcHandlers, invokeSafely, type IpcDeps } from './ipc';
import { defaultSettings } from './settings';
import type { ClipEntryDetail, DiagnosticsInfo } from '../shared/types';
import type { ClipStore } from './store';
import type { ClipboardWatcher, ClipboardPayload } from './clipboard-watcher';

/** 自检用的一张小 PNG（1×1），避免依赖外部文件 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

export interface SmokeContext {
  readonly store: ClipStore;
  readonly watcher: ClipboardWatcher;
  readonly deps: IpcDeps;
  /** 输出一行结果 */
  readonly log: (line: string) => void;
  /**
   * 在**渲染层**里求值一段脚本（真实走 preload → IPC 通路）。
   *
   * 为什么必须有这一步：主进程直接调处理器只能验证「处理器本身」，
   * 验证不了渲染层能不能真的调到它们 —— 而后者恰恰是最容易出错的地方
   * （preload 未注入、常量未内联、属性名不匹配等都会在这里暴露）。
   */
  readonly evaluateInRenderer: (expression: string) => Promise<unknown>;
}

export interface SmokeResult {
  readonly passed: number;
  readonly failed: readonly string[];
}

/** 自检期间写入的文本，用于搜索与筛选断言 */
const SMOKE_TEXT = '集成自检文本 Alpha 42';

/**
 * 执行集成自检。返回通过/失败项，由调用方决定退出码。
 */
export async function runIntegrationSmokeTest(context: SmokeContext): Promise<SmokeResult> {
  const { store, watcher, deps, log, evaluateInRenderer } = context;
  const failures: string[] = [];
  let passed = 0;

  const check = (condition: boolean, label: string): void => {
    log(`${condition ? '  ✓' : '  ✗'} ${label}`);
    if (condition) {
      passed += 1;
    } else {
      failures.push(label);
    }
  };

  // ---- 第 0 步：渲染层能否真的调到 IPC（最容易出错、也最该先验的地方）----
  const rendererProbe = (await evaluateInRenderer(`
    (() => {
      try {
        if (typeof window.clipHistory !== 'object' || window.clipHistory === null) {
          return { stage: 'bridge-missing', detail: 'window.clipHistory 不存在' };
        }
        const names = ['ping','diagnostics','listEntries','getEntry','setPinned','deleteEntry','restoreEntry','clearEntries','copyEntry','pasteEntry','getSettings','updateSettings','onEntriesChanged','onWatcherState'];
        const missing = names.filter((name) => typeof window.clipHistory[name] !== 'function');
        if (missing.length > 0) {
          return { stage: 'api-incomplete', detail: '缺少方法：' + missing.join(',') };
        }
        return { stage: 'ok', detail: '' };
      } catch (error) {
        return { stage: 'threw', detail: String(error && error.message ? error.message : error) };
      }
    })()
  `)) as { stage: string; detail: string } | undefined;

  if (rendererProbe === undefined) {
    check(false, '渲染层自检脚本应返回结果');
  } else if (rendererProbe.stage !== 'ok') {
    check(false, `渲染层可访问 preload API（阶段=${rendererProbe.stage}：${rendererProbe.detail}）`);
  } else {
    check(true, '渲染层可访问 preload API（14 个方法齐备）');
  }

  // 真实走一次 IPC：渲染层调用 listEntries
  const rendererListResult = (await evaluateInRenderer(
    'window.clipHistory.listEntries({})',
  )) as { ok?: boolean; error?: string; data?: unknown } | undefined;
  check(
    rendererListResult?.ok === true && Array.isArray(rendererListResult.data),
    `渲染层经 IPC 取列表成功${rendererListResult?.ok === true ? '' : `（错误：${String(rendererListResult?.error)}）`}`,
  );

  const rendererSettingsResult = (await evaluateInRenderer(
    'window.clipHistory.getSettings()',
  )) as { ok?: boolean; data?: { retentionDays?: number }; error?: string } | undefined;
  check(
    rendererSettingsResult?.ok === true && typeof rendererSettingsResult.data?.retentionDays === 'number',
    `渲染层经 IPC 读设置成功${rendererSettingsResult?.ok === true ? '' : `（错误：${String(rendererSettingsResult?.error)}）`}`,
  );

  const rendererDiagnostics = (await evaluateInRenderer(
    'window.clipHistory.diagnostics()',
  )) as { ok?: boolean; data?: { dataRoot?: string }; error?: string } | undefined;
  check(
    rendererDiagnostics?.ok === true && (rendererDiagnostics.data?.dataRoot ?? '').length > 0,
    `渲染层经 IPC 读诊断成功${rendererDiagnostics?.ok === true ? '' : `（错误：${String(rendererDiagnostics?.error)}）`}`,
  );

  // ---- 第 0.5 步：等界面完成初始化，再断言它真的装配好了 ----
  //
  // 为什么要「等」：`did-finish-load` 只表示文档与模块加载完成，而渲染层的 bootstrap
  // 还要 await 两次 IPC（读设置、取列表）才会把状态栏改成「已就绪」。
  // 如果在这里立刻断言，就会在界面仍显示「正在加载…」时误判为失败。
  // 这一步同时能抓住真实问题：模块静默不执行、或装配过程中抛异常 → 状态栏永远不会变。
  const readUiState = `
    (() => {
      const status = document.getElementById('status-text');
      const list = document.getElementById('list');
      return {
        bootState: document.body.dataset.bootState || '(未设置)',
        statusText: status === null ? '(缺少状态栏元素)' : status.textContent,
        listChildCount: list === null ? -1 : list.children.length,
        settingsPanelExists: document.getElementById('settings-panel') !== null,
        confirmDialogExists: document.getElementById('confirm-dialog') !== null,
        confirmOkExists: document.getElementById('confirm-ok') !== null,
      };
    })()
  `;

  interface UiState {
    bootState: string;
    statusText: string;
    listChildCount: number;
    settingsPanelExists: boolean;
    confirmDialogExists: boolean;
    confirmOkExists: boolean;
  }

  let uiState: UiState | undefined;
  const uiDeadline = Date.now() + 10_000;
  while (Date.now() < uiDeadline) {
    uiState = (await evaluateInRenderer(readUiState)) as UiState | undefined;
    // 以 body 上的就绪标记为准，而不是文案 —— 文案改动不应让验收误判
    if (uiState !== undefined && uiState.bootState === 'ready') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  check(
    uiState?.bootState === 'ready',
    `界面初始化完成（bootState=${String(uiState?.bootState)}，状态栏="${String(uiState?.statusText)}"）`,
  );
  check(
    uiState !== undefined && !uiState.statusText.includes('正在加载'),
    '状态栏已脱离「正在加载」状态',
  );
  check(
    uiState?.listChildCount !== undefined && uiState.listChildCount > 0,
    `列表区已渲染内容（子节点 ${String(uiState?.listChildCount)}）`,
  );
  check(
    uiState?.settingsPanelExists === true &&
      uiState.confirmDialogExists === true &&
      uiState.confirmOkExists === true,
    '设置面板与二次确认弹层的元素齐备（清空按钮可点）',
  );

  // ---- 第 0.6 步：弹层/面板的「隐藏」是否真的生效 ----
  //
  // 为什么必须用 getComputedStyle 而不是读 hidden 属性：`hidden` 属性靠 UA 样式表的
  // `display:none` 生效，一旦作者样式给元素写了 display（例如 `.modal{display:flex}`），
  // 属性为 true 但元素**依然可见** —— 本项目真实踩过（确认弹窗关不掉）。
  // 因此这里断言的是「计算后是否真的不渲染」。
  const layerState = (await evaluateInRenderer(`
    (() => {
      const dialog = document.getElementById('confirm-dialog');
      const panel = document.getElementById('settings-panel');
      const isHiddenVisually = (node) => {
        if (node === null) return 'missing';
        const style = window.getComputedStyle(node);
        const hiddenAttr = node.hasAttribute('hidden');
        if (style.display === 'none') return 'hidden';
        return hiddenAttr ? 'attr-hidden-but-visible' : 'visible';
      };
      return {
        dialogInitially: isHiddenVisually(dialog),
        panelInitially: isHiddenVisually(panel),
        dialogDisplay: dialog === null ? '(none)' : window.getComputedStyle(dialog).display,
        panelDisplay: panel === null ? '(none)' : window.getComputedStyle(panel).display,
      };
    })()
  `)) as
    | { dialogInitially: string; panelInitially: string; dialogDisplay: string; panelDisplay: string }
    | undefined;

  check(
    layerState?.dialogInitially === 'hidden',
    `二次确认弹层初始不可见（计算 display=${String(layerState?.dialogDisplay)}）`,
  );
  check(
    layerState?.panelInitially === 'hidden',
    `设置面板初始不可见（计算 display=${String(layerState?.panelDisplay)}）`,
  );

  // 打开设置面板 → 关闭 → 确认真的不可见（覆盖「设置面板关不掉」这类回归）
  const panelToggle = (await evaluateInRenderer(`
    (async () => {
      const panel = document.getElementById('settings-panel');
      const open = document.getElementById('settings-button');
      const close = document.getElementById('settings-close');
      const displayOf = () => window.getComputedStyle(panel).display;
      open.click();
      const afterOpen = displayOf();
      close.click();
      const afterClose = displayOf();
      return { afterOpen, afterClose };
    })()
  `)) as { afterOpen: string; afterClose: string } | undefined;
  check(
    panelToggle?.afterOpen !== 'none' && panelToggle?.afterClose === 'none',
    `设置面板可开可关（开=${String(panelToggle?.afterOpen)}，关=${String(panelToggle?.afterClose)}）`,
  );

  // 打开二次确认 → 点「取消」→ 确认真的不可见
  const dialogToggle = (await evaluateInRenderer(`
    (() => {
      const dialog = document.getElementById('confirm-dialog');
      const displayOf = () => window.getComputedStyle(dialog).display;
      document.getElementById('clear-button').click();
      const afterOpen = displayOf();
      document.getElementById('confirm-cancel').click();
      const afterCancel = displayOf();
      return { afterOpen, afterCancel };
    })()
  `)) as { afterOpen: string; afterCancel: string } | undefined;
  check(
    dialogToggle?.afterOpen !== 'none' && dialogToggle?.afterCancel === 'none',
    `清空确认弹层可开可取消（开=${String(dialogToggle?.afterOpen)}，取消后=${String(dialogToggle?.afterCancel)}）`,
  );

  const handlers = createIpcHandlers(deps);
  type HandlerName = keyof typeof handlers;

  const call = async (name: HandlerName, payload?: unknown): Promise<unknown> => {
    const result = await invokeSafely(handlers[name] as (input: unknown) => unknown, payload);
    if (!result.ok) {
      throw new Error(`处理器 ${String(name)} 失败：${result.error}`);
    }
    return result.data;
  };

  const rejectionOf = async (name: HandlerName, payload: unknown): Promise<string> => {
    const result = await invokeSafely(handlers[name] as (input: unknown) => unknown, payload);
    return result.ok ? '' : result.error;
  };

  // 自检环境下让相同内容的两次采集都能落库（否则会落入默认去重窗口）
  store.disableDedupForTest();

  const entriesBefore = store.stats().entries;

  log('  推进一轮文本采集…');
  watcher.forceNewContentForTest();
  watcher.pollWithPayloadForTest({ text: SMOKE_TEXT, imagePngBytes: null, imageWidth: 0, imageHeight: 0 });

  log('  推进一轮图片采集…');
  watcher.forceNewContentForTest();
  watcher.pollWithPayloadForTest({
    text: '',
    imagePngBytes: TINY_PNG,
    imageWidth: 1,
    imageHeight: 1,
  } satisfies ClipboardPayload);

  const stats = store.stats();
  check(stats.entries === entriesBefore + 2, `采集落库：文本与图片各一条（${String(entriesBefore)} → ${String(stats.entries)}）`);
  check(stats.text >= 1, `文本计数正确（${String(stats.text)}）`);
  check(stats.image >= 1, `图片计数正确（${String(stats.image)}）`);

  // ---- 列表 / 搜索 / 筛选 ----
  const list = (await call('listEntries', {})) as Array<{ id: string }>;
  check(list.length === stats.entries, `列表返回全部条目（${String(list.length)}）`);

  const searched = (await call('listEntries', { query: 'Alpha' })) as unknown[];
  check(searched.length === 1, `搜索命中英文关键词（${String(searched.length)}）`);

  const searchedChinese = (await call('listEntries', { query: '集成自检' })) as unknown[];
  check(searchedChinese.length === 1, `搜索命中中文关键词（${String(searchedChinese.length)}）`);

  const imagesOnly = (await call('listEntries', { kind: 'image' })) as Array<{ id: string; image?: unknown }>;
  check(imagesOnly.length === stats.image, `类型筛选只返回图片（${String(imagesOnly.length)}）`);
  check(imagesOnly[0]?.image !== undefined, '图片条目带回了图片元数据（供界面显示尺寸）');

  // ---- 置顶 / 详情 ----
  const targetId = imagesOnly[0]?.id ?? list[0]?.id ?? '';
  check(targetId !== '', '取得一条可操作的目标条目');

  const pinned = (await call('setPinned', { id: targetId, pinned: true })) as { pinned: boolean } | null;
  check(pinned?.pinned === true, '置顶生效');

  const detail = (await call('getEntry', { id: targetId })) as ClipEntryDetail | null;
  check(detail?.id === targetId, '按 id 取详情');

  // ---- 复制到剪贴板（文本条目）----
  const textEntry = (store.list({ kind: 'text' })[0] ?? null) as { id: string } | null;
  if (textEntry !== null) {
    const copied = (await call('copyEntry', { id: textEntry.id })) as { ok: boolean; error?: string };
    check(copied.ok, `文本条目可复制到剪贴板${copied.error === undefined ? '' : `（说明：${copied.error}）`}`);
  } else {
    check(false, '应存在一条文本条目用于复制测试');
  }

  // 图片复制当前如实返回未实现，不得假装成功
  const imageCopy = (await call('copyEntry', { id: targetId })) as { ok: boolean; error?: string };
  const imageCopyIsHonest = imageCopy.ok === false && (imageCopy.error ?? '').includes('后续版本');
  check(imageCopyIsHonest, `图片复制如实返回未实现而非假装成功（${String(imageCopy.error)}）`);

  // ---- 删除 / 撤销 ----
  const removed = (await call('deleteEntry', { id: targetId })) as boolean;
  check(removed === true, '删除单条成功');
  check(store.stats().entries === stats.entries - 1, '删除后条目数减一');

  const restoredEntry: ClipEntryDetail = detail ?? {
    id: targetId,
    kind: 'image',
    hash: 'smoke-restore',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: true,
  };
  const restored = (await call('restoreEntry', { entry: { ...restoredEntry, pinned: true } })) as { id: string };
  check(restored.id === targetId, '撤销删除可恢复条目');
  check(store.stats().entries === stats.entries, '撤销后条目数回到删除前');

  // ---- 设置读写 ----
  const updated = (await call('updateSettings', { retentionDays: 5, pasteMode: 'copyOnly' })) as {
    retentionDays: number;
    pasteMode: string;
  };
  check(updated.retentionDays === 5, '设置更新生效（retentionDays=5）');
  check(updated.pasteMode === 'copyOnly', '设置更新生效（pasteMode=copyOnly）');

  const readBack = (await call('getSettings')) as { retentionDays: number; pasteMode: string };
  check(readBack.retentionDays === 5 && readBack.pasteMode === 'copyOnly', '设置可回读（已落盘）');

  // 期限越界应被回退为默认值，而不是拒绝整次更新
  const coerced = (await call('updateSettings', { retentionDays: 9999 })) as { retentionDays: number };
  check(
    coerced.retentionDays === defaultSettings().retentionDays,
    `越界期限回退为默认值（${String(coerced.retentionDays)}）`,
  );

  // ---- 非法入参必须被拒绝（契约纪律 1）----
  const checks: Array<[HandlerName, unknown, string]> = [
    ['updateSettings', { retentionDays: '五天' }, '非法 retentionDays 被拒绝'],
    ['listEntries', { kind: 'video' }, '非法 kind 被拒绝'],
    ['clearEntries', { keepPinned: false }, '清空时 keepPinned=false 被拒绝'],
    ['getEntry', {}, '缺失 id 被拒绝'],
    ['setPinned', { id: '不存在', pinned: 'yes' }, '非布尔的 pinned 被拒绝'],
  ];
  for (const [name, payload, label] of checks) {
    const error = await rejectionOf(name, payload);
    check(error !== '', `${label}：${error}`);
  }

  const unknownEntry = await rejectionOf('setPinned', { id: '不存在的条目 id', pinned: true });
  check(unknownEntry.includes('已被删除'), `不存在的条目给出可行动提示：${unknownEntry}`);

  // ---- 诊断 ----
  const diagnostics = (await call('diagnostics')) as DiagnosticsInfo;
  check(diagnostics.entries === store.stats().entries, '诊断条目数与实际一致');
  check(diagnostics.watcherRunning, '诊断显示采集器在运行');
  check(diagnostics.cleanupRunning, '诊断显示清理器在运行');
  check(diagnostics.dataRoot.length > 0, `诊断返回数据目录（${diagnostics.dataRoot}）`);

  // ---- 清空：保留置顶 ----
  const clearResult = (await call('clearEntries', { keepPinned: true })) as { removed: number };
  const afterClear = store.stats();
  check(afterClear.pinned >= 1, `清空后置顶条目保留（${String(afterClear.pinned)} 条）`);
  check(afterClear.entries === afterClear.pinned, '清空后只剩置顶条目');
  check(clearResult.removed >= 1, `清空返回移除数量（${String(clearResult.removed)}）`);

  return { passed, failed: failures };
}
