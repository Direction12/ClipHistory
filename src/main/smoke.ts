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
  const { store, watcher, deps, log } = context;
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
