/**
 * 撤销暂存区单元测试 —— 对应 docs/测试与验收标准.md T-04「删除 / 撤销」的延伸。
 *
 * 覆盖的缺陷背景（Phase 6 修复）：删除图片时 PNG 被当场抹掉，撤销回来的卡片显示
 * 「图片已丢失」。修复后删除只是把文件搬进 `trash/`，撤销窗口内可原样找回。
 *
 * 运行方式：npm test
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TRASH_TTL_MS } from '../src/shared/constants';
import type { ClipEntryMeta } from '../src/shared/types';
import { createTestStore, TINY_PNG, type TestStoreHandle } from './helpers/paths';

const cleanups: Array<() => void> = [];
after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

interface TrashHarness {
  readonly handle: TestStoreHandle;
  /** 最近一次「安排暂存清理」收到的条目 id */
  readonly purgeCalls: string[];
}

function trackedStore(options: { startTime?: number } = {}): TrashHarness {
  const purgeCalls: string[] = [];
  const handle = createTestStore({
    ...options,
    schedulePurge: (entryId) => {
      purgeCalls.push(entryId);
    },
  });
  cleanups.push(handle.dispose);
  return { handle, purgeCalls };
}

/** 暂存区当前的文件名（升序），便于断言 */
function trashFiles(handle: TestStoreHandle): string[] {
  const directory = handle.paths.trashDir;
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function textFile(handle: TestStoreHandle, id: string): string {
  return join(handle.paths.contentDir, `${id}.txt`);
}

describe('撤销暂存区 — 删除与撤销（T-04）', () => {
  test('删除图片时把 PNG 搬进暂存区，而不是当场抹掉', () => {
    const { handle } = trackedStore();
    const entry = handle.store.addImage(TINY_PNG, 1, 1, handle.now()).entry!;
    const pngName = `${entry.hash}.png`;
    assert.ok(existsSync(join(handle.paths.imagesDir, pngName)), '前置条件：图片已落地 images/');

    assert.equal(handle.store.remove(entry.id), true);

    assert.equal(existsSync(join(handle.paths.imagesDir, pngName)), false, '图片应已离开 images/');
    assert.deepEqual(trashFiles(handle), [pngName], '图片应躺在暂存区里等撤销');
    assert.equal(handle.store.stats().entries, 0, '索引里该条已消失');
    assert.equal(handle.store.pendingTrashCount, 1);
  });

  test('撤销后图片原样回到 images/，条目恢复可用（原缺陷的回归断言）', () => {
    const { handle } = trackedStore();
    const entry = handle.store.addImage(TINY_PNG, 1, 1, handle.now()).entry!;
    const detail = handle.store.getDetail(entry.id)!;
    const pngName = `${entry.hash}.png`;

    handle.store.remove(entry.id);
    const restored = handle.store.restore(detail);

    assert.equal(restored.id, entry.id);
    assert.deepEqual(trashFiles(handle), [], '暂存区应已腾空');
    assert.deepEqual(
      readFileSync(join(handle.paths.imagesDir, pngName)),
      TINY_PNG,
      '还原的图片字节必须与原图完全一致',
    );

    const back = handle.store.list().find((meta) => meta.id === entry.id);
    assert.notEqual(back?.imageAvailable, false, '撤销后不得再显示「图片已丢失」');
    assert.equal(handle.store.pendingTrashCount, 0);
  });

  test('删除文字条目时全文进暂存区，撤销后内容一致', () => {
    const { handle } = trackedStore();
    const text = '这条文字必须能原样撤销回来';
    const entry = handle.store.addText(text, handle.now()).entry!;
    const detail = handle.store.getDetail(entry.id)!;

    handle.store.remove(entry.id);
    assert.deepEqual(trashFiles(handle), [`${entry.id}.txt`], '全文应搬进暂存区');
    assert.equal(existsSync(textFile(handle, entry.id)), false);

    handle.store.restore(detail);
    assert.equal(handle.store.readText(entry.id), text, '撤销后全文应可读且一致');
    assert.deepEqual(trashFiles(handle), []);
  });

  test('共用同一张图时，删掉一条不会把另一条的图搬走', () => {
    const { handle } = trackedStore();
    const first = handle.store.addImage(TINY_PNG, 1, 1, handle.now()).entry!;
    const pngName = `${first.hash}.png`;

    // 造一条引用同一张 PNG 的条目（图片按内容哈希命名，天然会被多条共用）
    const second: ClipEntryMeta = { ...first, id: 'shared-second', pinned: false };
    handle.store.appendRowForTest(second);

    const detail = handle.store.getDetail(first.id)!;
    assert.equal(handle.store.remove(first.id), true);

    assert.ok(existsSync(join(handle.paths.imagesDir, pngName)), '仍被引用的图绝不能搬走');
    assert.deepEqual(trashFiles(handle), [], '没有文件进暂存区');
    assert.equal(handle.store.pendingTrashCount, 0, '无文件可暂存时不应登记撤销记录');

    const other = handle.store.list().find((meta) => meta.id === second.id);
    assert.notEqual(other?.imageAvailable, false, '另一条不该被牵连成「图片已丢失」');

    handle.store.restore(detail);
    const restored = handle.store.list().find((meta) => meta.id === first.id);
    assert.notEqual(restored?.imageAvailable, false, '撤销后同样应可用');
  });

  test('撤销窗口内又复制了同一张图，撤销旧条目不会破坏新条目的图片', () => {
    const { handle } = trackedStore();
    const first = handle.store.addImage(TINY_PNG, 1, 1, handle.now()).entry!;
    const detail = handle.store.getDetail(first.id)!;
    const pngName = `${first.hash}.png`;

    handle.store.remove(first.id);

    // 关闭去重窗口后重新复制同一张图：会新建条目，并复用同名哈希文件
    handle.store.setDedupWindowProvider(() => 0);
    const second = handle.store.addImage(TINY_PNG, 1, 1, handle.now() + 1).entry!;
    assert.notEqual(second.id, first.id, '应是一条新条目');

    handle.store.restore(detail);

    for (const id of [first.id, second.id]) {
      const meta = handle.store.list().find((item) => item.id === id);
      assert.notEqual(meta?.imageAvailable, false, `${id} 的图片应仍可用`);
    }
    assert.deepEqual(readFileSync(join(handle.paths.imagesDir, pngName)), TINY_PNG);
  });

  test('内容本来就已丢失的条目，删除时不登记撤销也不排程', () => {
    const { handle, purgeCalls } = trackedStore();
    const entry = handle.store.addImage(TINY_PNG, 1, 1, handle.now()).entry!;
    const detail = handle.store.getDetail(entry.id)!;

    // 手工制造「文件已丢失」：图片不在了，再删条目
    handle.store.remove(entry.id);
    handle.store.purgeExpiredTrash(handle.now() + TRASH_TTL_MS + 1);
    assert.deepEqual(trashFiles(handle), []);

    handle.store.restore(detail);
    assert.equal(handle.store.remove(entry.id), true, '删除仍应成功');
    assert.equal(handle.store.pendingTrashCount, 0, '没有文件可暂存时不该留下假象');
    assert.deepEqual(purgeCalls, [entry.id], '只有第一次删除真正暂存了文件');
  });

  test('图片相对路径不安全时既不搬移也不排程', () => {
    const { handle, purgeCalls } = trackedStore();
    const evil: ClipEntryMeta = {
      id: 'evil-image',
      kind: 'image',
      hash: 'evil-hash',
      createdAt: handle.now(),
      updatedAt: handle.now(),
      pinned: false,
      image: { file: '../evil.png', width: 1, height: 1, sizeBytes: 1 },
    };
    handle.store.appendRowForTest(evil);

    assert.equal(handle.store.remove(evil.id), true);
    assert.deepEqual(trashFiles(handle), []);
    assert.deepEqual(purgeCalls, []);
  });
});

describe('撤销暂存区 — 过期与清理', () => {
  test('撤销窗口未到时文件保留，窗口过后被抹掉', () => {
    const { handle } = trackedStore();
    const entry = handle.store.addImage(TINY_PNG, 1, 1, handle.now()).entry!;
    const pngName = `${entry.hash}.png`;
    handle.store.remove(entry.id);

    const expiresAt = handle.now() + TRASH_TTL_MS;
    assert.equal(handle.store.purgeExpiredTrash(expiresAt - 1), 0, '差 1ms 到期就不该清');
    assert.deepEqual(trashFiles(handle), [pngName]);
    assert.equal(handle.store.pendingTrashCount, 1);

    assert.equal(handle.store.purgeExpiredTrash(expiresAt), 1, '到期即可清（含恰好到点）');
    assert.deepEqual(trashFiles(handle), []);
    assert.equal(handle.store.pendingTrashCount, 0);
  });

  test('判定依据是登记时刻而非文件时间（旧文件搬进来不能被误判过期）', () => {
    const start = 1_756_000_000_000;
    const { handle } = trackedStore({ startTime: start });
    const entry = handle.store.addImage(TINY_PNG, 1, 1, start).entry!;
    const pngName = `${entry.hash}.png`;
    handle.store.remove(entry.id);

    // 时钟只前进 1ms：文件 mtime 是「很久以前」（测试起点），但登记时刻才是判据
    const cleared = handle.store.purgeExpiredTrash(start + 1);
    assert.equal(cleared, 0);
    assert.ok(existsSync(join(handle.paths.trashDir, pngName)));
  });

  test('启动即清空暂存区：异常退出留下的文件不会长期占盘', () => {
    const first = trackedStore();
    const entry = first.handle.store.addImage(TINY_PNG, 1, 1, first.handle.now()).entry!;
    first.handle.store.remove(entry.id);
    assert.equal(trashFiles(first.handle).length, 1, '前置条件：暂存区里有文件');

    // 用同一数据目录重开一个 store，等价于「进程重启」
    const secondHandle = createTestStore({
      dataPaths: first.handle.paths,
      startTime: first.handle.now() + 1000,
    });
    cleanups.push(secondHandle.dispose);

    assert.deepEqual(trashFiles(secondHandle), [], '新进程启动应清空暂存区');
    assert.equal(secondHandle.store.pendingTrashCount, 0);
  });

  test('孤儿图片回收不会碰暂存区', () => {
    const { handle } = trackedStore();
    const entry = handle.store.addImage(TINY_PNG, 1, 1, handle.now()).entry!;
    const pngName = `${entry.hash}.png`;
    handle.store.remove(entry.id);

    assert.deepEqual(handle.store.collectOrphanImages(), [], '暂存文件不属于「孤儿图片」');
    assert.deepEqual(trashFiles(handle), [pngName], '待撤销的图必须活到窗口结束');
  });

  test('超过窗口后：文字可凭全文重建，图片保持「已丢失」并由界面明示', () => {
    const textHarness = trackedStore();
    const text = '过期之后仍然要靠全文重建';
    const textEntry = textHarness.handle.store.addText(text, textHarness.handle.now()).entry!;
    const textDetail = textHarness.handle.store.getDetail(textEntry.id)!;
    textHarness.handle.store.remove(textEntry.id);
    textHarness.handle.store.purgeExpiredTrash(textHarness.handle.now() + TRASH_TTL_MS + 1);
    textHarness.handle.store.restore(textDetail);
    assert.equal(textHarness.handle.store.readText(textEntry.id), text, '文字总能重建');

    const imageHarness = trackedStore();
    const imageEntry = imageHarness.handle.store.addImage(TINY_PNG, 1, 1, imageHarness.handle.now()).entry!;
    const imageDetail = imageHarness.handle.store.getDetail(imageEntry.id)!;
    imageHarness.handle.store.remove(imageEntry.id);
    imageHarness.handle.store.purgeExpiredTrash(imageHarness.handle.now() + TRASH_TTL_MS + 1);
    imageHarness.handle.store.restore(imageDetail);

    const back = imageHarness.handle.store.list().find((meta) => meta.id === imageEntry.id);
    assert.equal(back?.imageAvailable, false, '图片确实找不回——界面必须明示而不是假装成功');
  });
});
