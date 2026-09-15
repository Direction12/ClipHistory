/**
 * 搜索与类型筛选单元测试 —— 对应 docs/测试与验收标准.md §2 的 T-12 ~ T-14。
 *
 * 运行方式（见 docs/构建与运行.md §2.4）：
 *   node --test --experimental-test-isolation=none "test/*.test.ts"
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClipStore } from '../src/main/store';
import { createTestStore, makeTextEntry, TINY_PNG } from './helpers/paths';

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

/** 造一个包含文字与图片的库，供筛选类用例复用 */
function seedLibrary() {
  const handle = trackedStore();
  const { store } = handle;

  store.addText('今天的会议记录：讨论发布节奏');
  store.addText('GitHub Pull Request 地址');
  store.addText('12345 纯数字内容');
  store.addImage(TINY_PNG, 1, 1);

  return handle;
}

describe('搜索（T-12）', () => {
  test('空查询返回全部条目', () => {
    const { store } = seedLibrary();
    assert.equal(store.list().length, 4);
    assert.equal(store.list({ query: '' }).length, 4);
    assert.equal(store.list({ query: '   ' }).length, 4, '纯空白查询等同空查询');
  });

  test('英文搜索大小写不敏感', () => {
    const { store } = seedLibrary();

    for (const query of ['github', 'GITHUB', 'GitHub', 'gItHuB']) {
      const hits = store.list({ query });
      assert.equal(hits.length, 1, `查询「${query}」应命中 1 条`);
      assert.match(hits[0]?.textPreview ?? '', /GitHub/);
    }
  });

  test('中文关键词可命中', () => {
    const { store } = seedLibrary();

    const hits = store.list({ query: '会议记录' });
    assert.equal(hits.length, 1);
    assert.match(hits[0]?.textPreview ?? '', /会议记录/);
  });

  test('无匹配时返回空数组而不是报错', () => {
    const { store } = seedLibrary();
    assert.deepEqual(store.list({ query: '完全不存在的关键词' }), []);
  });

  test('关键词位于预览之外时仍能命中（会回退到读全文）', () => {
    const { store } = trackedStore();
    // 预览只保留前 120 字符，此处把关键词放在很后面
    const long = `${'前'.repeat(200)}目标关键词在很后面`;
    store.addText(long);

    const hits = store.list({ query: '目标关键词在很后面' });
    assert.equal(hits.length, 1, '全文搜索必须能命中预览之外的内容');
  });

  test('跨换行内容可被单段关键词命中', () => {
    const { store } = trackedStore();
    store.addText('第一行内容\n第二行有独特标记XYZ\n第三行内容');

    const hits = store.list({ query: '独特标记XYZ' });
    assert.equal(hits.length, 1);
  });

  test('搜索结果同样按 updatedAt 降序', () => {
    const { store, advance } = trackedStore();
    // 每次追加都推进时间：一是保证三条时间戳互不相同，
    // 二是越过默认去重窗口，避免同内容被判定为重复
    store.addText('共同关键词 最早');
    advance(10_000);
    store.addText('共同关键词 中间');
    advance(10_000);
    store.addText('共同关键词 最新');

    const hits = store.list({ query: '共同关键词' });
    assert.equal(hits.length, 3);
    assert.match(hits[0]?.textPreview ?? '', /最新/);
    assert.match(hits[1]?.textPreview ?? '', /中间/);
    assert.match(hits[2]?.textPreview ?? '', /最早/);
  });
});

describe('类型筛选（T-13）', () => {
  test('all / text / image 三种筛选各自正确', () => {
    const { store } = seedLibrary();

    assert.equal(store.list({ kind: 'all' }).length, 4);
    assert.equal(store.list({ kind: 'text' }).length, 3);
    assert.equal(store.list({ kind: 'image' }).length, 1);
    assert.ok(store.list({ kind: 'image' })[0]?.image !== undefined);
  });

  test('筛选与搜索叠加结果正确', () => {
    const { store } = seedLibrary();

    assert.equal(store.list({ query: '会议', kind: 'text' }).length, 1);
    assert.equal(store.list({ query: '会议', kind: 'image' }).length, 0, '图片不参与文本搜索');
    assert.equal(store.list({ query: '', kind: 'image' }).length, 1);
  });

  test('图片条目不会被文本关键词误命中', () => {
    const { store } = seedLibrary();
    assert.equal(store.list({ query: 'png' }).length, 0, '不应对图片做文件名匹配');
  });
});

describe('搜索健壮性（T-14）', () => {
  test('条目缺失全文文件时不抛异常，只是搜不到', () => {
    const { store, paths } = trackedStore();
    store.addText('有全文的记录');

    // 关键词刻意放在预览范围（前 120 字符）之外，确保命中与否只取决于能否读到全文文件
    const tailMarker = '末段独有标记ZZZ';
    const orphan = store.addText(`${'占'.repeat(200)}${tailMarker}`).entry!;
    rmSync(join(paths.contentDir, `${orphan.id}.txt`));

    assert.doesNotThrow(() => store.list({ query: tailMarker }));
    assert.equal(store.list({ query: tailMarker }).length, 0, '读不到全文就不应命中');
    assert.equal(store.list().length, 2, '列表本身仍应包含该条目');
  });

  test('索引里含字段缺失的条目时搜索不崩，只是跳过', () => {
    const { store, paths } = trackedStore();
    store.appendRowForTest(makeTextEntry('good', 1000, { hash: 'h-good' }));

    // 手工写入一条字段不完整的行
    const raw = readFileSync(paths.indexFile, 'utf8');
    writeFileSync(paths.indexFile, `${raw}${JSON.stringify({ id: 'broken' })}\n`, 'utf8');

    const reopened = new ClipStore({ paths });
    reopened.init();

    assert.doesNotThrow(() => reopened.list({ query: '预览' }));
    assert.equal(reopened.stats().entries, 1, '坏行被跳过，好行保留');
  });
});
