/**
 * IPC 处理器单元测试 —— 覆盖 docs/技术方案.md §5 的契约纪律与 §5.3 的错误语义。
 *
 * 重点验证「渲染层入参不可信」这条纪律：合法的能过、非法的必须被拒绝且给出可行动提示。
 * 集成自检（src/main/smoke.ts）负责端到端串联，这里只做单元级校验。
 *
 * 运行方式：npm test
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers, invokeSafely, validateSettingsSeed, type IpcDeps } from '../src/main/ipc';
import { defaultSettings } from '../src/main/settings';
import type { ClipEntryDetail, ClipEntryMeta, Settings } from '../src/shared/types';
import { createTestStore } from './helpers/paths';

const cleanups: Array<() => void> = [];
after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

interface Harness {
  readonly deps: IpcDeps;
  readonly call: (name: string, payload?: unknown) => Promise<unknown>;
  readonly rejectionOf: (name: string, payload: unknown) => Promise<string>;
  readonly pausedStates: boolean[];
}

/** 建立一套带真实 store 的处理器环境 */
function createHarness(): Harness {
  const handle = createTestStore();
  cleanups.push(handle.dispose);
  const store = handle.store;
  store.disableDedupForTest();

  let settings: Settings = defaultSettings();
  const pausedStates: boolean[] = [];

  const deps: IpcDeps = {
    getStore: () => store,
    readSettings: () => settings,
    updateSettings: (seed) => {
      settings = { ...settings, ...seed } as Settings;
      return settings;
    },
    setPaused: (paused) => {
      pausedStates.push(paused);
    },
    isPaused: () => settings.paused,
    isWatcherRunning: () => true,
    isCleanupRunning: () => true,
    getDataRoot: () => handle.paths.root,
    paste: {
      writeEntryToClipboard: async () => ({ ok: true }),
      pasteEntryToActiveWindow: async () => ({ ok: true, mode: 'auto', autoPasted: false }),
    },
  };

  const handlers = createIpcHandlers(deps) as Record<string, (input: unknown) => unknown>;

  return {
    deps,
    pausedStates,
    call: async (name, payload) => {
      const result = await invokeSafely(handlers[name]!, payload);
      if (!result.ok) {
        throw new Error(`处理器 ${name} 失败：${result.error}`);
      }
      return result.data;
    },
    rejectionOf: async (name, payload) => {
      const result = await invokeSafely(handlers[name]!, payload);
      return result.ok ? '' : result.error;
    },
  };
}

/** 造一条真实条目，并返回其 id */
function seedText(h: Harness, text: string): string {
  const store = h.deps.getStore();
  if (store === null) throw new Error('测试环境缺少 store');
  return store.addText(text).entry!.id;
}

describe('IPC 列表与筛选', () => {
  test('空入参返回全部条目', async () => {
    const h = createHarness();
    seedText(h, '第一条');
    seedText(h, '第二条');

    const list = (await h.call('listEntries', {})) as ClipEntryMeta[];
    assert.equal(list.length, 2);
  });

  test('入参为 undefined 也可用（等价于默认查询）', async () => {
    const h = createHarness();
    seedText(h, '内容');
    const list = (await h.call('listEntries')) as ClipEntryMeta[];
    assert.equal(list.length, 1);
  });

  test('按关键词搜索', async () => {
    const h = createHarness();
    seedText(h, '苹果香蕉');
    seedText(h, '橙子');

    const hit = (await h.call('listEntries', { query: '香蕉' })) as ClipEntryMeta[];
    assert.equal(hit.length, 1);
  });

  test('按类型筛选', async () => {
    const h = createHarness();
    seedText(h, '文本条目');
    h.deps.getStore()!.addImage(TINY_PNG, 1, 1);

    const images = (await h.call('listEntries', { kind: 'image' })) as ClipEntryMeta[];
    assert.equal(images.length, 1);
    assert.equal(images[0]?.kind, 'image');
  });

  test('非法的 kind 被拒绝', async () => {
    const h = createHarness();
    const error = await h.rejectionOf('listEntries', { kind: 'video' });
    assert.match(error, /kind/);
  });

  test('query 类型错误被拒绝', async () => {
    const h = createHarness();
    const error = await h.rejectionOf('listEntries', { query: 123 });
    assert.match(error, /query/);
  });

  test('入参不是对象时被拒绝', async () => {
    const h = createHarness();
    const error = await h.rejectionOf('listEntries', '不是对象');
    assert.match(error, /对象/);
  });
});

describe('IPC 条目操作', () => {
  test('置顶与取消置顶', async () => {
    const h = createHarness();
    const id = seedText(h, '待置顶');

    const pinned = (await h.call('setPinned', { id, pinned: true })) as ClipEntryMeta;
    assert.equal(pinned.pinned, true);

    const unpinned = (await h.call('setPinned', { id, pinned: false })) as ClipEntryMeta;
    assert.equal(unpinned.pinned, false);
  });

  test('非布尔的 pinned 被拒绝', async () => {
    const h = createHarness();
    const id = seedText(h, '内容');
    const error = await h.rejectionOf('setPinned', { id, pinned: 'yes' });
    assert.match(error, /pinned/);
  });

  test('操作不存在的条目时给出可行动提示', async () => {
    const h = createHarness();
    const error = await h.rejectionOf('setPinned', { id: '不存在', pinned: true });
    assert.match(error, /已被删除/);
  });

  test('删除与撤销', async () => {
    const h = createHarness();
    const id = seedText(h, '待删除内容');
    const detail = (await h.call('getEntry', { id })) as ClipEntryDetail;

    assert.equal(await h.call('deleteEntry', { id }), true);
    assert.equal(h.deps.getStore()!.get(id), null);

    const restored = (await h.call('restoreEntry', { entry: detail })) as ClipEntryMeta;
    assert.equal(restored.id, id);
    assert.equal(h.deps.getStore()!.getDetail(id)?.text, '待删除内容', '全文必须一并恢复');
  });

  test('撤销删除的入参缺少必需字段时被拒绝（该数据会直接写回索引）', async () => {
    const h = createHarness();
    const error = await h.rejectionOf('restoreEntry', {
      entry: { id: 'x', kind: 'text' },
    });
    assert.match(error, /entry\.hash/);
  });

  test('撤销删除时 kind 非法被拒绝', async () => {
    const h = createHarness();
    const error = await h.rejectionOf('restoreEntry', {
      entry: { id: 'x', kind: 'video', hash: 'h', createdAt: 1, updatedAt: 1, pinned: false },
    });
    assert.match(error, /kind/);
  });

  test('清空始终保留置顶条目', async () => {
    const h = createHarness();
    const keep = seedText(h, '置顶的');
    seedText(h, '普通的');
    await h.call('setPinned', { id: keep, pinned: true });

    const result = (await h.call('clearEntries', { keepPinned: true })) as { removed: number };
    assert.equal(result.removed, 1);
    assert.equal(h.deps.getStore()!.stats().entries, 1);
    assert.equal(h.deps.getStore()!.list()[0]?.id, keep);
  });

  test('清空时传 keepPinned=false 被拒绝（不接受的取值）', async () => {
    const h = createHarness();
    const error = await h.rejectionOf('clearEntries', { keepPinned: false });
    assert.match(error, /keepPinned/);
  });

  test('取不存在的详情返回 null 而不是抛错', async () => {
    const h = createHarness();
    assert.equal(await h.call('getEntry', { id: '不存在' }), null);
  });
});

describe('IPC 设置', () => {
  test('读取设置返回完整结构', async () => {
    const h = createHarness();
    const settings = (await h.call('getSettings')) as Settings;
    assert.equal(settings.retentionDays, defaultSettings().retentionDays);
    assert.equal(settings.pasteMode, 'auto');
  });

  test('更新设置返回校验后的结果', async () => {
    const h = createHarness();
    const updated = (await h.call('updateSettings', { retentionDays: 5, pasteMode: 'copyOnly' })) as Settings;
    assert.equal(updated.retentionDays, 5);
    assert.equal(updated.pasteMode, 'copyOnly');
  });

  test('更新 paused 会同步给采集器（否则暂停只写进文件）', async () => {
    const h = createHarness();
    await h.call('updateSettings', { paused: true });
    assert.deepEqual(h.pausedStates, [true]);
  });

  test('非法 retentionDays 类型被拒绝', async () => {
    const h = createHarness();
    const error = await h.rejectionOf('updateSettings', { retentionDays: '五天' });
    assert.match(error, /retentionDays/);
  });

  test('非整数 retentionDays 被拒绝', async () => {
    const h = createHarness();
    const error = await h.rejectionOf('updateSettings', { retentionDays: 2.5 });
    assert.match(error, /整数/);
  });

  test('非法 pasteMode 被拒绝', async () => {
    const h = createHarness();
    const error = await h.rejectionOf('updateSettings', { pasteMode: 'always' });
    assert.match(error, /pasteMode/);
  });

  test('非布尔 paused 被拒绝', async () => {
    const h = createHarness();
    const error = await h.rejectionOf('updateSettings', { paused: 'yes' });
    assert.match(error, /paused/);
  });

  test('windowBounds 缺字段被拒绝', async () => {
    const h = createHarness();
    const error = await h.rejectionOf('updateSettings', { windowBounds: { x: 1, y: 2 } });
    assert.match(error, /windowBounds\.width/);
  });
});

describe('IPC 校验辅助函数', () => {
  test('validateSettingsSeed 只保留认识的字段', () => {
    const seed = validateSettingsSeed({ retentionDays: 3, 恶意字段: 'x' });
    assert.deepEqual(Object.keys(seed), ['retentionDays']);
  });

  test('validateSettingsSeed 接受空对象', () => {
    assert.deepEqual(validateSettingsSeed({}), {});
  });

  test('invokeSafely 把异常转成 ok:false 信封', async () => {
    const result = await invokeSafely(() => {
      throw new Error('故意失败');
    }, undefined);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.error : '', '故意失败');
  });

  test('invokeSafely 成功时包成 ok:true', async () => {
    const result = await invokeSafely(() => 42, undefined);
    assert.deepEqual(result, { ok: true, data: 42 });
  });

  test('invokeSafely 也能包装异步处理器', async () => {
    const result = await invokeSafely(async () => '异步结果', undefined);
    assert.deepEqual(result, { ok: true, data: '异步结果' });
  });
});

describe('IPC 诊断', () => {
  test('诊断返回计数与运行状态，且不含剪贴板内容', async () => {
    const h = createHarness();
    seedText(h, '这是一段不该出现在诊断里的正文内容');

    const info = (await h.call('diagnostics')) as Record<string, unknown>;
    assert.equal(info.entries, 1);
    assert.equal(info.text, 1);
    assert.equal(info.watcherRunning, true);
    assert.equal(info.cleanupRunning, true);

    // 关键：诊断里不得出现任何剪贴板原文（见 CLAUDE.md §5.6）
    const serialized = JSON.stringify(info);
    assert.ok(!serialized.includes('不该出现在诊断里'), `诊断结果泄露了剪贴板内容：${serialized}`);
  });
});
