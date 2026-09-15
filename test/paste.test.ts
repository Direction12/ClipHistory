/**
 * 剪贴板写回（paste）单元测试 —— 覆盖 FR-06 防自触发与「不假装成功」的要求。
 *
 * 当前阶段（Phase 4）只实现文本写回；图片写回在 Electron 44 下尚无可行 API
 * （见 docs/技术方案.md C-05），因此必须如实返回失败，不得静默成功。
 *
 * 运行方式：npm test
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPasteService } from '../src/main/paste';
import type { ClipEntryDetail } from '../src/shared/types';
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

describe('写回剪贴板 — 文本', () => {
  test('文本可成功写回剪贴板', async () => {
    const handle = createTestStore();
    cleanups.push(handle.dispose);
    const written: string[] = [];

    const service = createPasteService({
      store: { getDetail: (id) => handle.store.getDetail(id) },
      clipboard: {
        writeText: (text: string) => {
          written.push(text);
        },
      },
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
    });

    const id = handle.store.addText('要复制的内容').entry!.id;
    const result = await service.writeEntryToClipboard(id);

    assert.equal(result.ok, true);
    assert.deepEqual(written, ['要复制的内容']);
  });

  test('写回成功后调用 onSelfWrite（防自触发）', async () => {
    const handle = createTestStore();
    cleanups.push(handle.dispose);
    const written: string[] = [];
    let selfWriteCount = 0;

    const service = createPasteService({
      store: { getDetail: (id) => handle.store.getDetail(id) },
      clipboard: {
        writeText: (text: string) => {
          written.push(text);
        },
      },
      onSelfWrite: () => {
        selfWriteCount += 1;
      },
      getPasteMode: () => 'auto',
    });

    const id = handle.store.addText('需要复制的内容').entry!.id;
    const result = await service.writeEntryToClipboard(id);

    assert.equal(result.ok, true);
    assert.deepEqual(written, ['需要复制的内容']);
    assert.equal(selfWriteCount, 1, '成功写回后必须声明自写回');
  });

  test('写回失败时不调用 onSelfWrite（否则真正的外部复制会被漏记）', async () => {
    const handle = createTestStore();
    cleanups.push(handle.dispose);
    let selfWriteCount = 0;

    const service = createPasteService({
      store: { getDetail: (id) => handle.store.getDetail(id) },
      clipboard: {
        writeText: () => {
          throw new Error('剪贴板被占用');
        },
      },
      onSelfWrite: () => {
        selfWriteCount += 1;
      },
      getPasteMode: () => 'auto',
    });

    const id = handle.store.addText('写不进去的内容').entry!.id;
    const result = await service.writeEntryToClipboard(id);

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /剪贴板被占用/);
    assert.equal(selfWriteCount, 0, '失败时绝不能声明自写回');
  });

  test('条目不存在时给出可行动提示', async () => {
    const handle = createTestStore();
    cleanups.push(handle.dispose);

    const service = createPasteService({
      store: { getDetail: () => null },
      clipboard: { writeText: () => undefined },
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
    });

    const result = await service.writeEntryToClipboard('不存在的 id');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /已被删除/);
  });

  test('全文丢失时不假装成功', async () => {
    const handle = createTestStore();
    cleanups.push(handle.dispose);
    const id = handle.store.addText('内容会被删').entry!.id;

    const service = createPasteService({
      store: {
        getDetail: (entryId: string): ClipEntryDetail | null => {
          const detail = handle.store.getDetail(entryId);
          if (detail === null) return null;
          // 模拟全文文件丢失
          return { ...detail, text: undefined };
        },
      },
      clipboard: { writeText: () => undefined },
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
    });

    const result = await service.writeEntryToClipboard(id);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /全文已丢失/);
  });
});

describe('写回剪贴板 — 图片（尚未实现，必须如实告知）', () => {
  test('图片复制返回明确失败，且说明是后续版本提供', async () => {
    const handle = createTestStore();
    cleanups.push(handle.dispose);
    handle.store.addImage(TINY_PNG, 1, 1);
    const id = handle.store.list({ kind: 'image' })[0]!.id;

    let selfWriteCount = 0;
    const service = createPasteService({
      store: { getDetail: (entryId) => handle.store.getDetail(entryId) },
      clipboard: { writeText: () => undefined },
      onSelfWrite: () => {
        selfWriteCount += 1;
      },
      getPasteMode: () => 'auto',
    });

    const result = await service.writeEntryToClipboard(id);

    assert.equal(result.ok, false, '不得假装成功');
    assert.match(result.error ?? '', /后续版本/);
    assert.equal(selfWriteCount, 0, '没写成功就不该声明自写回');
  });
});

describe('粘贴到前台窗口 — 如实区分「已复制」与「已粘贴」', () => {
  test('copyOnly 模式下不尝试自动粘贴，且不报错', async () => {
    const handle = createTestStore();
    cleanups.push(handle.dispose);
    const id = handle.store.addText('仅复制模式').entry!.id;

    const service = createPasteService({
      store: { getDetail: (entryId) => handle.store.getDetail(entryId) },
      clipboard: { writeText: () => undefined },
      onSelfWrite: () => undefined,
      getPasteMode: () => 'copyOnly',
    });

    const result = await service.pasteEntryToActiveWindow(id);

    assert.equal(result.ok, true, '仅复制是用户的选择，不是失败');
    assert.equal(result.autoPasted, false);
    assert.equal(result.mode, 'copyOnly');
    assert.equal(result.notice, undefined, '仅复制模式下无需额外提示');
  });

  test('auto 模式下已复制但自动粘贴未实现时，如实返回 notice', async () => {
    const handle = createTestStore();
    cleanups.push(handle.dispose);
    const id = handle.store.addText('自动粘贴待实现').entry!.id;

    const service = createPasteService({
      store: { getDetail: (entryId) => handle.store.getDetail(entryId) },
      clipboard: { writeText: () => undefined },
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
    });

    const result = await service.pasteEntryToActiveWindow(id);

    assert.equal(result.ok, true, '复制步骤成功');
    assert.equal(result.autoPasted, false, '不得谎报已经粘贴');
    assert.match(result.notice ?? '', /Ctrl\+V/, '必须告诉用户下一步怎么做');
  });

  test('复制失败时整体失败并带回原因', async () => {
    const handle = createTestStore();
    cleanups.push(handle.dispose);
    const id = handle.store.addText('写不进去').entry!.id;

    const service = createPasteService({
      store: { getDetail: (entryId) => handle.store.getDetail(entryId) },
      clipboard: {
        writeText: () => {
          throw new Error('剪贴板被占用');
        },
      },
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
    });

    const result = await service.pasteEntryToActiveWindow(id);

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /剪贴板被占用/);
    assert.equal(result.autoPasted, false);
  });
});
