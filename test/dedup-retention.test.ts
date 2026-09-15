/**
 * 去重与保留策略单元测试 —— 对应 docs/测试与验收标准.md §2 的 T-05、T-06、T-06b。
 *
 * 去重的判定逻辑在本文件覆盖；定时清理的任务编排属 Phase 3（cleanup.ts），
 * 本文件先覆盖 store.cleanupExpired 这个纯函数核心（T-08、T-09 的核心判定）。
 *
 * 运行方式（见 docs/构建与运行.md §2.4）：
 *   node --test --experimental-test-isolation=none "test/*.test.ts"
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ClipStore } from '../src/main/store';
import { hashImage, hashText, normalizeText } from '../src/main/content';
import { createTestStore, TINY_PNG } from './helpers/paths';

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

describe('去重 — 窗口内与窗口外（T-05）', () => {
  test('窗口内重复内容只算一次动作，不新增条目也不改动时间', () => {
    const { store, advance } = trackedStore();
    store.setDedupWindowProvider(() => 5000);

    const first = store.addText('重复的内容');
    const before = store.list()[0]?.updatedAt;

    advance(1000);
    const second = store.addText('重复的内容');

    assert.equal(second.skippedAsDuplicate, true, '窗口内应被判定为重复');
    assert.equal(store.stats().entries, 1, '不应新增条目');
    assert.equal(store.list()[0]?.updatedAt, before, '窗口内被忽略时连时间也不应改动');
    assert.equal(second.entry?.id, first.entry?.id);
  });

  test('超出窗口再次复制则刷新时间并回到顶部，但仍不新增条目', () => {
    const { store, advance } = trackedStore();
    store.setDedupWindowProvider(() => 5000);

    store.addText('内容 A');
    advance(1000);
    store.addText('内容 B');
    // 此时 B 在顶部
    assert.match(store.list()[0]?.textPreview ?? '', /内容 B/);

    advance(10_000); // 越过 5 秒窗口
    const refreshed = store.addText('内容 A');

    assert.equal(refreshed.skippedAsDuplicate, false, '超出窗口不算重复动作');
    assert.equal(store.stats().entries, 2, '仍不应产生重复条目');
    assert.match(store.list()[0]?.textPreview ?? '', /内容 A/, '刷新后应回到列表顶部');
  });

  test('去重窗口为 0 时任何重复都视为新动作，但依然复用同一条目', () => {
    const { store } = trackedStore();
    store.setDedupWindowProvider(() => 0);

    const a = store.addText('同样的内容');
    const b = store.addText('同样的内容');

    assert.equal(a.entry?.id, b.entry?.id, '同一内容始终对应同一条目');
    assert.equal(store.stats().entries, 1);
  });

  test('不同内容互不干扰', () => {
    const { store } = trackedStore();
    store.setDedupWindowProvider(() => 60_000);

    store.addText('内容一');
    store.addText('内容二');
    store.addText('内容三');

    assert.equal(store.stats().entries, 3);
  });

  test('文字与图片各自独立去重，互不影响', () => {
    const { store } = trackedStore();
    store.setDedupWindowProvider(() => 60_000);

    store.addText('xx');
    store.addImage(TINY_PNG, 1, 1);
    store.addImage(TINY_PNG, 1, 1);

    const stats = store.stats();
    assert.equal(stats.entries, 2, '一张图片 + 一条文字');
    assert.equal(stats.image, 1, '重复图片应被去重');
  });
});

describe('哈希归一化（T-06）', () => {
  test('\\r\\n 与 \\n 归一化后哈希相同，因此视为同一内容', () => {
    assert.equal(normalizeText('a\r\nb'), 'a\nb');
    assert.equal(hashText(normalizeText('a\r\nb')), hashText(normalizeText('a\nb')));

    const { store } = trackedStore();
    store.setDedupWindowProvider(() => 60_000);

    store.addText('第一行\r\n第二行');
    store.addText('第一行\n第二行');

    assert.equal(store.stats().entries, 1, '仅换行符不同应被判定为同一内容');
  });

  test('BOM 不影响哈希', () => {
    assert.equal(hashText(normalizeText('\uFEFFabc')), hashText(normalizeText('abc')));
  });

  test('图片哈希基于 PNG 字节', () => {
    const other = Buffer.from(TINY_PNG);
    other[other.length - 1] = (other[other.length - 1]! + 1) % 256;

    assert.equal(hashImage(TINY_PNG), hashImage(Buffer.from(TINY_PNG)), '同字节同哈希');
    assert.notEqual(hashImage(TINY_PNG), hashImage(other), '字节不同则哈希不同');
  });
});

describe('保留策略 — 过期判定与置顶豁免（T-08 / T-09 核心逻辑）', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  test('未置顶条目在期限后被清理', () => {
    const { store, advance } = trackedStore();
    store.addText('一天前的记录');

    advance(DAY_MS + 1000);
    const cutoff = 1_756_000_000_000 + DAY_MS; // 1 天期限的截止点
    const result = store.cleanupExpired(cutoff);

    assert.equal(result.removedEntryIds.length, 1);
    assert.equal(store.stats().entries, 0);
  });

  test('恰好等于截止时间的条目不被清理（边界为严格早于）', () => {
    const { store } = trackedStore();
    const entry = store.addText('正好卡在边界').entry!;

    const result = store.cleanupExpired(entry.updatedAt);

    assert.equal(result.removedEntryIds.length, 0, 'updatedAt >= cutoff 必须保留');
    assert.equal(store.stats().entries, 1);
  });

  test('晚于截止时间的条目不被清理', () => {
    const { store } = trackedStore();
    store.addText('比较新的记录');

    const result = store.cleanupExpired(1_756_000_000_000 - 1000);

    assert.equal(result.removedEntryIds.length, 0);
    assert.equal(store.stats().entries, 1);
  });

  test('置顶条目即使用户选了 1 天也永不自动清理', () => {
    const { store, advance } = trackedStore();
    const keep = store.addText('重要的置顶内容').entry!;
    store.addText('普通的旧内容');
    store.setPinned(keep.id, true);

    advance(365 * DAY_MS); // 远超任何期限
    const cutoff = 1_756_000_000_000 + DAY_MS;
    const result = store.cleanupExpired(cutoff);

    assert.equal(store.stats().entries, 1);
    assert.equal(store.list()[0]?.id, keep.id, '置顶条目必须保留');
    assert.equal(store.list()[0]?.pinned, true);
    assert.ok(!result.removedEntryIds.includes(keep.id));
  });

  test('清理会连带删除过期条目的全文文件', () => {
    const { store, paths, advance } = trackedStore();
    const entry = store.addText('会被清理的记录').entry!;
    const contentFile = join(paths.contentDir, `${entry.id}.txt`);
    assert.ok(existsSync(contentFile));

    advance(5 * DAY_MS);
    store.cleanupExpired(1_756_000_000_000 + DAY_MS);

    assert.equal(existsSync(contentFile), false);
  });

  test('相同图片内容不会产生第二个条目（图片按哈希天然去重）', () => {
    const { store, paths, advance } = trackedStore();
    store.setDedupWindowProvider(() => 1000);

    const first = store.addImage(TINY_PNG, 1, 1);
    advance(5000); // 越过去重窗口
    const second = store.addImage(TINY_PNG, 1, 1);

    assert.equal(store.stats().image, 1, '同一图片内容始终只对应一个条目');
    assert.equal(second.entry?.id, first.entry?.id);
    assert.equal(second.skippedAsDuplicate, false, '超出窗口不算重复动作，只是刷新时间');

    const pngFiles = readdirSync(paths.imagesDir).filter((name) => name.endsWith('.png'));
    assert.equal(pngFiles.length, 1, '只应占用一个图片文件');
  });

  test('清理不会误删仍被引用的图片文件（两条目共享同一图片）', () => {
    const { store, paths } = trackedStore();
    store.setDedupWindowProvider(() => 1000);

    // 先真实写入图片文件
    const created = store.addImage(TINY_PNG, 1, 1);
    const sharedFile = created.entry!.image!.file;
    const imageFile = join(paths.root, sharedFile);
    assert.ok(existsSync(imageFile), '图片文件应已落盘');

    // 再补一条引用同一文件的条目，用于构造「多条目共享同一图片」。
    // 通过索引接缝构造，因为正常的 addImage 会按哈希去重，永远不会产生第二条。
    store.appendRowForTest({
      id: 'second-reference',
      kind: 'image',
      hash: 'different-hash-same-file',
      createdAt: created.entry!.createdAt,
      updatedAt: created.entry!.updatedAt,
      pinned: false,
      image: created.entry!.image!,
    });
    assert.equal(store.stats().image, 2, '应为两条目共享同一文件');

    // 只移除其中一条：另一条仍在引用，文件必须保留
    assert.equal(store.remove(created.entry!.id), true);

    assert.ok(existsSync(imageFile), '仍被引用的图片不得被回收');
    assert.equal(store.stats().image, 1);
  });

  test('清理后不再被引用的图片会被回收', () => {
    const { store, paths, advance } = trackedStore();
    const entry = store.addImage(TINY_PNG, 1, 1);
    const imageFile = join(paths.root, entry.entry!.image!.file);

    advance(2 * DAY_MS);
    store.cleanupExpired(1_756_000_000_000 + 1000);

    assert.equal(store.stats().image, 0);
    assert.equal(existsSync(imageFile), false, '孤儿图片应被回收');
  });

  test('重新打开库后清理结果保持一致（清理是持久化的）', () => {
    const { store, paths, advance } = trackedStore();
    store.addText('旧记录');
    advance(3 * DAY_MS);
    store.addText('新记录');

    store.cleanupExpired(1_756_000_000_000 + DAY_MS);
    store.compact();

    const reopened = new ClipStore({ paths });
    reopened.init();

    assert.equal(reopened.stats().entries, 1);
    assert.match(reopened.list()[0]?.textPreview ?? '', /新记录/);
  });
});
