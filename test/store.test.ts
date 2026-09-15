/**
 * store 单元测试 —— 对应 docs/测试与验收标准.md §2 的 T-01 ~ T-04、T-11。
 *
 * 运行方式（见 docs/构建与运行.md §2.4）：
 *   node --test --experimental-test-isolation=none "test/*.test.ts"
 *
 * 同进程运行，无隔离，故每个用例自建并清理自己的临时目录。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClipStore } from '../src/main/store';
import { MAX_ENTRIES } from '../src/shared/constants';
import { createTestStore, makeTextEntry, TINY_PNG } from './helpers/paths';

/** 所有用例的清理句柄：保证测试结束后不留下临时目录 */
const handles: Array<() => void> = [];
after(() => {
  for (const dispose of handles) {
    dispose();
  }
});

function trackedStore(startTime?: number) {
  const handle = createTestStore({ startTime });
  handles.push(handle.dispose);
  return handle;
}

describe('store 索引 — 追加与折叠（T-01）', () => {
  test('addText 后重新读取索引，内容一致', () => {
    const { store, paths } = trackedStore();

    const result = store.addText('你好，世界');
    assert.equal(result.skippedAsDuplicate, false);
    assert.ok(result.entry !== null);

    // 用一个新的 store 从磁盘重新读取，验证确实落盘而非只在内存
    const reopened = new ClipStore({ paths });
    reopened.init();

    const list = reopened.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.textPreview, '你好，世界');
    assert.equal(reopened.readText(list[0]!.id), '你好，世界');
  });

  test('同一 id 的多行以最后一行为准（后写覆盖前写）', () => {
    const { store, paths } = trackedStore();
    const base = makeTextEntry('entry-1', 1000, { hash: 'h1' });

    store.appendRowForTest(base);
    store.appendRowForTest({ ...base, textPreview: '改过之后的预览', pinned: true });

    const list = store.list();
    assert.equal(list.length, 1, '两条同 id 的行应当折叠为一条');
    assert.equal(list[0]?.textPreview, '改过之后的预览');
    assert.equal(list[0]?.pinned, true);

    // 磁盘上保留两行（追加式），折叠只发生在读取时
    const raw = readFileSync(paths.indexFile, 'utf8').trim().split('\n');
    assert.equal(raw.length, 2);
  });

  test('列表按 updatedAt 降序', () => {
    const { store } = trackedStore();
    store.appendRowForTest(makeTextEntry('a', 1000));
    store.appendRowForTest(makeTextEntry('b', 3000));
    store.appendRowForTest(makeTextEntry('c', 2000));

    assert.deepEqual(
      store.list().map((meta) => meta.id),
      ['b', 'c', 'a'],
    );
  });
});

describe('store 容错 — 损坏行不影响其余数据（T-02）', () => {
  test('损坏行被跳过并计数，其余数据完整可读', () => {
    const { store, paths } = trackedStore();
    store.addText('第一条');
    store.addText('第二条');

    // 手工插入三种坏行：非法 JSON、JSON 但字段缺失、空行
    const raw = readFileSync(paths.indexFile, 'utf8');
    const corrupted = [
      '这不是合法 JSON{{{',
      JSON.stringify({ id: 'missing-fields' }),
      '',
      raw,
    ].join('\n');
    writeFileSync(paths.indexFile, corrupted, 'utf8');

    const reopened = new ClipStore({ paths });
    reopened.init();

    assert.equal(reopened.stats().entries, 2, '两条正常记录都必须保留');
    assert.equal(reopened.damagedLines, 2, '两条坏行应被计数');
    assert.equal(reopened.list().length, 2);
  });

  test('写入中断留下的末尾半行被安全忽略，且不产生半条记录', () => {
    const { store, paths } = trackedStore();
    store.addText('完好的记录');

    // 模拟崩溃：文件末尾追加一段被截断的 JSON
    const truncated = '{"id":"half-written","kind":"text","hash":"abc","createdA';
    writeFileSync(paths.indexFile, `${readFileSync(paths.indexFile, 'utf8')}${truncated}`, 'utf8');

    const reopened = new ClipStore({ paths });
    reopened.init();

    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.damagedLines, 1);
    assert.equal(reopened.list()[0]?.textPreview, '完好的记录');
  });

  test('越界的图片路径被拒绝（索引按不可信输入处理）', () => {
    const { store, paths } = trackedStore();
    store.appendRowForTest({
      id: 'evil',
      kind: 'image',
      hash: 'h-evil',
      createdAt: 1000,
      updatedAt: 1000,
      pinned: false,
      image: { file: '../../../../Windows/System32/config/SAM', width: 1, height: 1, sizeBytes: 1 },
    });

    const reopened = new ClipStore({ paths });
    reopened.init();

    assert.equal(reopened.stats().entries, 0, '含路径穿越的条目必须被整行丢弃');
    assert.equal(reopened.damagedLines, 1);
  });
});

describe('store 压缩（T-03）', () => {
  test('压缩后条目数与内容不变，冗余行被清除', () => {
    const { store, paths } = trackedStore();
    const base = makeTextEntry('dup', 1000, { hash: 'h-dup' });

    // 同一 id 追加多次，制造冗余
    for (let i = 0; i < 20; i += 1) {
      store.appendRowForTest({ ...base, updatedAt: 1000 + i });
    }
    store.appendRowForTest(makeTextEntry('other', 500, { hash: 'h-other' }));

    const beforeCount = store.list().length;
    const beforeTop = store.list()[0];

    store.compact();

    const reopened = new ClipStore({ paths });
    reopened.init();

    assert.equal(reopened.list().length, beforeCount, '压缩不应改变条目数');
    assert.equal(reopened.list()[0]?.id, beforeTop?.id);
    assert.equal(reopened.list()[0]?.updatedAt, beforeTop?.updatedAt);

    const lines = readFileSync(paths.indexFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, beforeCount, '压缩后每行应恰好对应一个条目');
  });

  test('压缩在冗余达到阈值且总量可观时自动触发', () => {
    const { store, paths } = trackedStore();
    const base = makeTextEntry('repeat', 1000, { hash: 'h-repeat' });

    // 阈值是 2000 行且行数 > 条目数 × 2；追加 2100 行后应自动压缩
    for (let i = 0; i < 2100; i += 1) {
      store.appendRowForTest({ ...base, updatedAt: 1000 + i });
    }

    const lines = readFileSync(paths.indexFile, 'utf8').trim().split('\n');
    assert.ok(lines.length < 2100, `索引应已被压缩，实际仍有 ${String(lines.length)} 行`);
    assert.equal(store.list().length, 1);
  });
});

describe('store 文本读写与忽略规则（T-04 / T-07）', () => {
  test('空串、纯空白、仅换行不入库', () => {
    const { store } = trackedStore();

    assert.equal(store.addText('').entry, null);
    assert.equal(store.addText('   ').entry, null);
    assert.equal(store.addText('\n\n').entry, null);
    assert.equal(store.addText('\r\n\t  \n').entry, null);

    assert.equal(store.stats().entries, 0);
  });

  test('超长文本被截断并标记，且换行被统一为 \\n', () => {
    const { store } = trackedStore();
    const long = 'a'.repeat(100_001);

    const result = store.addText(long);
    assert.ok(result.entry !== null);
    assert.equal(result.entry.truncated, true);
    assert.equal(result.entry.textPreview?.length, 121, '预览应为 120 字符 + 省略号');

    const stored = store.readText(result.entry.id);
    assert.equal(stored?.length, 100_000, '全文应被截断到上限');

    const crlf = store.addText('第一行\r\n第二行\r第三行');
    assert.equal(store.readText(crlf.entry!.id), '第一行\n第二行\n第三行', '换行应统一为 \\n');
  });

  test('带 BOM 的文本被去除 BOM', () => {
    const { store } = trackedStore();
    const result = store.addText('\uFEFF带 BOM 的内容');
    assert.equal(store.readText(result.entry!.id), '带 BOM 的内容');
  });

  test('全文文件缺失时条目仍在，readText 返回 null', () => {
    const { store, paths } = trackedStore();
    const result = store.addText('内容会被手工删掉');
    const id = result.entry!.id;

    // 模拟全文文件丢失
    const contentFile = join(paths.contentDir, `${id}.txt`);
    assert.ok(existsSync(contentFile));
    rmSync(contentFile);

    assert.equal(store.get(id)?.id, id, '条目本身应保留');
    assert.equal(store.readText(id), null);
    assert.equal(store.getDetail(id)?.text, undefined, '详情里不应带出不存在的全文');
  });
});

describe('store 删除 / 撤销 / 清空（T-04）', () => {
  test('删除会把全文文件移出 content/（撤销窗口内暂存在 trash/）', () => {
    const { store, paths } = trackedStore();
    const result = store.addText('待删除');
    const id = result.entry!.id;
    const contentFile = join(paths.contentDir, `${id}.txt`);
    assert.ok(existsSync(contentFile));

    assert.equal(store.remove(id), true);

    assert.equal(store.get(id), null);
    assert.equal(existsSync(contentFile), false, '删除条目应连带移除全文文件');
    assert.ok(existsSync(join(paths.trashDir, `${id}.txt`)), '文件先进暂存区，等撤销窗口结束（详见 trash.test.ts）');
  });

  test('撤销删除可把条目与全文一并恢复', () => {
    const { store } = trackedStore();
    const result = store.addText('需要撤销的内容');
    const detail = store.getDetail(result.entry!.id)!;

    store.remove(detail.id);
    assert.equal(store.get(detail.id), null);

    store.restore(detail);

    const restored = store.getDetail(detail.id);
    assert.ok(restored !== null);
    assert.equal(restored.text, '需要撤销的内容', '全文必须被恢复');
  });

  test('清空历史默认保留置顶条目', () => {
    const { store } = trackedStore();
    const keep = store.addText('置顶的').entry!;
    store.addText('普通的');

    store.setPinned(keep.id, true);
    const { removed } = store.clear(true);

    assert.equal(removed, 1, '只应移除未置顶的那条');
    assert.equal(store.stats().entries, 1);
    assert.equal(store.list()[0]?.id, keep.id);
    assert.equal(store.list()[0]?.pinned, true);
  });

  test('置顶切换会写入索引并可被重新读取', () => {
    const { store, paths } = trackedStore();
    const entry = store.addText('准备置顶').entry!;

    store.setPinned(entry.id, true);
    const reopened = new ClipStore({ paths });
    reopened.init();

    assert.equal(reopened.get(entry.id)?.pinned, true);
  });
});

describe('store 图片（T-04）', () => {
  test('图片按哈希命名落盘，相同内容复用同一文件', () => {
    const { store, paths } = trackedStore();

    const first = store.addImage(TINY_PNG, 1, 1);
    assert.ok(first.entry?.image !== undefined);
    const file = first.entry.image.file;
    assert.ok(file.startsWith('images/'));
    assert.ok(file.endsWith('.png'));

    const absolute = join(paths.root, file);
    assert.ok(existsSync(absolute), '图片文件应已落盘');
    assert.equal(statSync(absolute).size, TINY_PNG.length);

    // 同内容、超出去重窗口 → 刷新时间而不新增条目，且不产生第二个文件
    store.setDedupWindowProvider(() => 0);
    store.addImage(TINY_PNG, 1, 1, first.entry.updatedAt + 10_000);

    const pngFiles = readdirSync(paths.imagesDir).filter((name) => name.endsWith('.png'));
    assert.equal(pngFiles.length, 1, '相同图片内容只应占用一个文件');
  });

  test('删除图片条目后图片离开 images/，不再被索引引用', () => {
    const { store, paths } = trackedStore();
    const result = store.addImage(TINY_PNG, 1, 1);
    const absolute = join(paths.root, result.entry!.image!.file);
    assert.ok(existsSync(absolute));

    store.remove(result.entry!.id);

    assert.equal(existsSync(absolute), false, '图片应离开 images/');
    assert.deepEqual(store.collectOrphanImages(), [], '暂存文件不是孤儿，回收不得碰它');
  });
});

describe('store 条目上限（T-11）', () => {
  test('超过上限时优先收缩最旧的未置顶条目，置顶条目保留', () => {
    const { store } = trackedStore();
    const over = MAX_ENTRIES + 5;

    const entries = [];
    for (let i = 0; i < over; i += 1) {
      // 前 3 条置顶（最新时间），其余未置顶且时间递增
      entries.push(makeTextEntry(`e${String(i)}`, 1000 + i, { pinned: i < 3, hash: `h${String(i)}` }));
    }
    store.replaceEntriesForTest(entries);

    const removed = store.enforceEntryLimit();

    assert.equal(removed, 5, `应恰好移除超出的 5 条，实际 ${String(removed)}`);
    assert.equal(store.stats().entries, MAX_ENTRIES);
    assert.equal(store.stats().pinned, 3, '置顶条目必须全部保留');
  });

  test('全为置顶时停止收缩，不误删置顶条目', () => {
    const { store } = trackedStore();
    const over = MAX_ENTRIES + 10;

    const entries = [];
    for (let i = 0; i < over; i += 1) {
      entries.push(makeTextEntry(`p${String(i)}`, 1000 + i, { pinned: true, hash: `ph${String(i)}` }));
    }
    store.replaceEntriesForTest(entries);

    const removed = store.enforceEntryLimit();

    assert.equal(removed, 0, '没有任何可收缩的条目时应停止');
    assert.equal(store.stats().entries, over);
  });
});
