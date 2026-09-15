/**
 * 保留策略编排单元测试 —— 对应 docs/测试与验收标准.md §2 的 T-08、T-09、T-10
 * 在「编排层」的延伸：截止时间计算、执行时机、以及清理后的孤儿回收边界。
 *
 * 判定逻辑本体（哪些条目该删）已在 Phase 2 的 store 测试里覆盖，
 * 这里只测本模块新增的东西：cutoff 算法、非法设置的保护、调度触发。
 *
 * 运行方式：npm test
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CleanupScheduler, calculateCutoff, runCleanup } from '../src/main/cleanup';
import { defaultSettings } from '../src/main/settings';
import { createTestStore, TINY_PNG } from './helpers/paths';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_TIME = 1_756_000_000_000;

const cleanups: Array<() => void> = [];
after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

function trackedStore(startTime?: number) {
  const handle = createTestStore({ startTime });
  cleanups.push(handle.dispose);
  return handle;
}

describe('保留策略 — 截止时间计算（T-08）', () => {
  test('1/3/5 天各自算出正确的截止时间', () => {
    assert.equal(calculateCutoff(BASE_TIME, 1), BASE_TIME - DAY_MS);
    assert.equal(calculateCutoff(BASE_TIME, 3), BASE_TIME - 3 * DAY_MS);
    assert.equal(calculateCutoff(BASE_TIME, 5), BASE_TIME - 5 * DAY_MS);
  });

  test('截止时间随当前时间前移，不等同于固定日期', () => {
    const later = calculateCutoff(BASE_TIME + 10 * DAY_MS, 1);
    assert.equal(later, BASE_TIME + 9 * DAY_MS);
    assert.ok(later > calculateCutoff(BASE_TIME, 1));
  });
});

describe('保留策略 — runCleanup 的边界与保护', () => {
  test('未置顶的过期条目被清理，置顶条目保留', () => {
    const { store } = trackedStore(BASE_TIME);
    const keep = store.addText('置顶的重要记录').entry!;
    store.addText('普通的旧记录');
    store.setPinned(keep.id, true);

    const now = BASE_TIME + 2 * DAY_MS;
    const run = runCleanup(store, { ...defaultSettings(), retentionDays: 1 }, now);

    assert.ok(run !== null);
    assert.equal(run.retentionDays, 1);
    assert.equal(run.cutoff, now - DAY_MS);
    assert.equal(run.result.removedEntryIds.length, 1, '只应清掉未置顶的那条');
    assert.equal(store.stats().entries, 1);
    assert.equal(store.list()[0]?.id, keep.id);
  });

  test('恰好到期（updatedAt === cutoff）不被清理，刚过期才清理', () => {
    const { store } = trackedStore(BASE_TIME);
    const entry = store.addText('卡在边界上的记录').entry!;

    // cutoff 恰好等于 updatedAt → 判定条件是 updatedAt < cutoff，故保留
    const noopRun = runCleanup(store, { ...defaultSettings(), retentionDays: 1 }, entry.updatedAt + DAY_MS);
    assert.equal(noopRun?.result.removedEntryIds.length, 0);
    assert.equal(store.stats().entries, 1);

    // 再前移 1 毫秒 → 变成严格过期
    const expiredRun = runCleanup(store, { ...defaultSettings(), retentionDays: 1 }, entry.updatedAt + DAY_MS + 1);
    assert.equal(expiredRun?.result.removedEntryIds.length, 1);
    assert.equal(store.stats().entries, 0);
  });

  test('retentionDays 非法时不做任何清理（避免坏设置删数据）', () => {
    const { store } = trackedStore(BASE_TIME);
    store.addText('不该被删的记录');

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const run = runCleanup(store, { ...defaultSettings(), retentionDays: bad }, BASE_TIME + 100 * DAY_MS);
      assert.equal(run, null, `retentionDays=${String(bad)} 应被拒绝`);
      assert.equal(store.stats().entries, 1, '数据必须原封不动');
    }
  });

  test('期限越长，截止时间越早（同一时刻下多保留历史）', () => {
    const now = BASE_TIME + 10 * DAY_MS;
    assert.ok(calculateCutoff(now, 5) < calculateCutoff(now, 3));
    assert.ok(calculateCutoff(now, 3) < calculateCutoff(now, 1));

    // 一条 2 天前的记录：3 天期限下仍在期内，1 天期限下已过期
    const twoDaysAgo = now - 2 * DAY_MS;

    const lenient = trackedStore();
    lenient.store.addText('2 天前的记录', twoDaysAgo);
    const keptRun = runCleanup(lenient.store, { ...defaultSettings(), retentionDays: 3 }, now);
    assert.equal(keptRun?.result.removedEntryIds.length, 0, '3 天期限应保留 2 天前的记录');
    assert.equal(lenient.store.stats().entries, 1);

    const strict = trackedStore();
    strict.store.addText('2 天前的记录', twoDaysAgo);
    const removedRun = runCleanup(strict.store, { ...defaultSettings(), retentionDays: 1 }, now);
    assert.equal(removedRun?.result.removedEntryIds.length, 1, '1 天期限应清掉 2 天前的记录');
    assert.equal(strict.store.stats().entries, 0);
  });
});

describe('保留策略 — 孤儿图片回收（T-10）', () => {
  test('过期图片条目的文件被回收', () => {
    const { store, paths } = trackedStore(BASE_TIME);
    const created = store.addImage(TINY_PNG, 1, 1);
    const imageFile = join(paths.root, created.entry!.image!.file);
    assert.ok(existsSync(imageFile));

    runCleanup(store, { ...defaultSettings(), retentionDays: 1 }, BASE_TIME + 2 * DAY_MS);

    assert.equal(store.stats().image, 0);
    assert.equal(existsSync(imageFile), false, '孤儿图片应被回收');
  });

  test('置顶的图片条目过期后文件必须保留（回收不得误伤置顶）', () => {
    const { store, paths } = trackedStore(BASE_TIME);
    const created = store.addImage(TINY_PNG, 1, 1);
    store.setPinned(created.entry!.id, true);
    const imageFile = join(paths.root, created.entry!.image!.file);

    runCleanup(store, { ...defaultSettings(), retentionDays: 1 }, BASE_TIME + 30 * DAY_MS);

    assert.equal(store.stats().image, 1, '置顶图片条目应保留');
    assert.ok(existsSync(imageFile), '置顶条目引用的文件不得被当作孤儿回收');
  });

  test('清理后没有过期条目时，图片文件也不该被回收', () => {
    const { store, paths } = trackedStore(BASE_TIME);
    const created = store.addImage(TINY_PNG, 1, 1);
    const imageFile = join(paths.root, created.entry!.image!.file);

    runCleanup(store, { ...defaultSettings(), retentionDays: 5 }, BASE_TIME + DAY_MS);

    assert.ok(existsSync(imageFile));
  });
});

describe('清理调度器 — 执行时机（FR-12）', () => {
  test('start 会立即执行一次（对应「应用启动时」）', () => {
    const { store } = trackedStore(BASE_TIME);
    store.addText('旧记录');
    const triggers: string[] = [];

    const scheduler = new CleanupScheduler({
      store,
      getSettings: () => ({ ...defaultSettings(), retentionDays: 1 }),
      now: () => BASE_TIME + 2 * DAY_MS,
      intervalMs: 60_000,
      onCleaned: (_run, trigger) => triggers.push(trigger),
    });

    scheduler.start();
    const running = scheduler.isRunning;
    scheduler.stop();

    assert.equal(running, true);
    assert.deepEqual(triggers, ['startup']);
    assert.equal(store.stats().entries, 0, '启动清理应已生效');
  });

  test('每次执行前重新读取设置，改动立即生效', () => {
    const { store, advance } = trackedStore(BASE_TIME);
    store.addText('2 天前的记录');
    // 前移到 2 天后：相对 5 天期限仍在期内，相对 1 天期限已过期。
    // 注意要让 updatedAt 严格早于 cutoff，否则会落在「恰好到期」的保留边界上。
    advance(2 * DAY_MS);
    let retentionDays = 5;

    const scheduler = new CleanupScheduler({
      store,
      getSettings: () => ({ ...defaultSettings(), retentionDays }),
      now: () => BASE_TIME + 2 * DAY_MS,
      intervalMs: 60_000,
    });

    // 5 天期限：不该清理
    assert.equal(scheduler.runOnce('settings-changed')?.result.removedEntryIds.length, 0);
    assert.equal(store.stats().entries, 1);

    // 用户把期限改成 1 天：同一份数据立刻被清理
    retentionDays = 1;
    assert.equal(scheduler.runOnce('settings-changed')?.result.removedEntryIds.length, 1);
    assert.equal(store.stats().entries, 0);
  });

  test('stop 之后不再触发清理', () => {
    const { store } = trackedStore(BASE_TIME);
    let count = 0;

    const scheduler = new CleanupScheduler({
      store,
      getSettings: () => defaultSettings(),
      now: () => BASE_TIME,
      intervalMs: 60_000,
      onCleaned: () => {
        count += 1;
      },
    });

    scheduler.start();
    assert.equal(scheduler.isRunning, true);
    scheduler.stop();
    assert.equal(scheduler.isRunning, false);
    const afterStop = count;

    scheduler.stop(); // 幂等
    assert.equal(count, afterStop, '停止后不应再有回调');
  });
});
