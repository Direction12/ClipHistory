/**
 * 剪贴板写回与自动粘贴单元测试 —— 覆盖 FR-06 防自触发、FR-13 粘贴模式、
 * LIM-01 提权窗口降级，以及「不假装成功」的要求。
 *
 * 写回方式来自运行时实测（见 docs/技术方案.md C-05）：
 * - 文字：Electron `clipboard.writeText()`
 * - 图片：**必须走 Windows 原生剪贴板**（Electron 的 `write()` 对图片会「成功但没写进去」）
 *
 * 运行方式：npm test
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPasteService, type ClipboardWriter } from '../src/main/paste';
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

interface HarnessOptions {
  mode?: 'auto' | 'copyOnly';
  failTextWrite?: boolean;
  failImageWrite?: string;
  failSendKeys?: string;
  failHide?: boolean;
  missingImageFile?: boolean;
}

interface Harness {
  readonly service: ReturnType<typeof createPasteService>;
  readonly writtenText: string[];
  readonly writtenImages: Buffer[];
  readonly selfWrites: () => number;
  readonly windowEvents: string[];
  readonly focusWaits: number[];
}

function createHarness(options: HarnessOptions = {}): Harness {
  const handle = createTestStore();
  cleanups.push(handle.dispose);
  const store = handle.store;

  const writtenText: string[] = [];
  const writtenImages: Buffer[] = [];
  const windowEvents: string[] = [];
  const focusWaits: number[] = [];
  let selfWriteCount = 0;

  const clipboard: ClipboardWriter = {
    writeText: async (text: string) => {
      if (options.failTextWrite === true) {
        throw new Error('剪贴板被占用');
      }
      writtenText.push(text);
    },
    writeImagePng: async (pngBytes: Buffer) => {
      if (options.failImageWrite !== undefined) {
        return { ok: false, error: options.failImageWrite };
      }
      writtenImages.push(pngBytes);
      return { ok: true };
    },
  };

  const service = createPasteService({
    store: { getDetail: (id: string): ClipEntryDetail | null => store.getDetail(id) },
    clipboard,
    readImageBytes: async (relativePath: string) => {
      if (options.missingImageFile === true) {
        return null;
      }
      void relativePath;
      return TINY_PNG;
    },
    sendPasteKeys: async () => {
      if (options.failSendKeys !== undefined) {
        return { ok: false, error: options.failSendKeys };
      }
      return { ok: true };
    },
    hideAppWindow: async () => {
      if (options.failHide === true) {
        throw new Error('隐藏窗口失败');
      }
      windowEvents.push('hide');
    },
    showAppWindow: () => {
      windowEvents.push('show');
    },
    onSelfWrite: () => {
      selfWriteCount += 1;
    },
    getPasteMode: () => options.mode ?? 'auto',
    wait: async (ms: number) => {
      focusWaits.push(ms);
    },
  });

  return {
    service,
    writtenText,
    writtenImages,
    selfWrites: () => selfWriteCount,
    windowEvents,
    focusWaits,
  };
}

/** 造一条文本条目并返回 id */
function seedText(store: ReturnType<typeof createTestStore>['store'], text: string): string {
  return store.addText(text).entry!.id;
}

/** 在本 harness 的 store 之外再造一个 store，用于需要自定义 store 的用例 */
function createStore(): ReturnType<typeof createTestStore> {
  const handle = createTestStore();
  cleanups.push(handle.dispose);
  return handle;
}

describe('写回剪贴板 — 文本', () => {
  test('文本写回成功', async () => {
    const handle = createStore();
    const written: string[] = [];
    const service = createPasteService({
      store: { getDetail: (id) => handle.store.getDetail(id) },
      clipboard: { writeText: async (t) => void written.push(t), writeImagePng: async () => ({ ok: true }) },
      readImageBytes: async () => null,
      sendPasteKeys: async () => ({ ok: true }),
      hideAppWindow: async () => undefined,
      showAppWindow: () => undefined,
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
      wait: async () => undefined,
    });

    const id = seedText(handle.store, '要复制的内容');
    const result = await service.writeEntryToClipboard(id);

    assert.equal(result.ok, true);
    assert.deepEqual(written, ['要复制的内容']);
  });

  test('写回成功后声明自写回（防自触发）', async () => {
    const own = createStore();
    const written: string[] = [];
    let selfWrites = 0;
    const service = createPasteService({
      store: { getDetail: (entryId) => own.store.getDetail(entryId) },
      clipboard: { writeText: async (t) => void written.push(t), writeImagePng: async () => ({ ok: true }) },
      readImageBytes: async () => null,
      sendPasteKeys: async () => ({ ok: true }),
      hideAppWindow: async () => undefined,
      showAppWindow: () => undefined,
      onSelfWrite: () => {
        selfWrites += 1;
      },
      getPasteMode: () => 'auto',
      wait: async () => undefined,
    });

    const id = own.store.addText('需要复制的内容').entry!.id;
    const result = await service.writeEntryToClipboard(id);

    assert.equal(result.ok, true);
    assert.equal(selfWrites, 1, '成功写回后必须声明自写回');
    assert.deepEqual(written, ['需要复制的内容']);
  });

  test('写回失败时不声明自写回（否则真正的外部复制会被漏记）', async () => {
    const own = createStore();
    let selfWrites = 0;
    const service = createPasteService({
      store: { getDetail: (id) => own.store.getDetail(id) },
      clipboard: {
        writeText: async () => {
          throw new Error('剪贴板被占用');
        },
        writeImagePng: async () => ({ ok: true }),
      },
      readImageBytes: async () => null,
      sendPasteKeys: async () => ({ ok: true }),
      hideAppWindow: async () => undefined,
      showAppWindow: () => undefined,
      onSelfWrite: () => {
        selfWrites += 1;
      },
      getPasteMode: () => 'auto',
      wait: async () => undefined,
    });

    const id = own.store.addText('写不进去的内容').entry!.id;
    const result = await service.writeEntryToClipboard(id);

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /剪贴板被占用/);
    assert.equal(selfWrites, 0, '失败时绝不能声明自写回');
  });

  test('条目不存在时给出可行动提示', async () => {
    const service = createPasteService({
      store: { getDetail: () => null },
      clipboard: { writeText: async () => undefined, writeImagePng: async () => ({ ok: true }) },
      readImageBytes: async () => null,
      sendPasteKeys: async () => ({ ok: true }),
      hideAppWindow: async () => undefined,
      showAppWindow: () => undefined,
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
      wait: async () => undefined,
    });

    const result = await service.writeEntryToClipboard('不存在');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /已被删除/);
  });

  test('全文丢失时不假装成功', async () => {
    const own = createStore();
    const id = own.store.addText('内容会被删').entry!.id;

    const service = createPasteService({
      store: {
        getDetail: (entryId): ClipEntryDetail | null => {
          const detail = own.store.getDetail(entryId);
          return detail === null ? null : { ...detail, text: undefined };
        },
      },
      clipboard: { writeText: async () => undefined, writeImagePng: async () => ({ ok: true }) },
      readImageBytes: async () => null,
      sendPasteKeys: async () => ({ ok: true }),
      hideAppWindow: async () => undefined,
      showAppWindow: () => undefined,
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
      wait: async () => undefined,
    });

    const result = await service.writeEntryToClipboard(id);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /全文已丢失/);
  });
});

describe('写回剪贴板 — 图片（走 Windows 原生剪贴板）', () => {
  test('图片写回会把 PNG 字节交给原生剪贴板，并声明自写回', async () => {
    const own = createStore();
    own.store.addImage(TINY_PNG, 1, 1);
    const id = own.store.list({ kind: 'image' })[0]!.id;

    const images: Buffer[] = [];
    let selfWrites = 0;
    const service = createPasteService({
      store: { getDetail: (entryId) => own.store.getDetail(entryId) },
      clipboard: {
        writeText: async () => undefined,
        writeImagePng: async (bytes: Buffer) => {
          images.push(bytes);
          return { ok: true };
        },
      },
      readImageBytes: async () => TINY_PNG,
      sendPasteKeys: async () => ({ ok: true }),
      hideAppWindow: async () => undefined,
      showAppWindow: () => undefined,
      onSelfWrite: () => {
        selfWrites += 1;
      },
      getPasteMode: () => 'auto',
      wait: async () => undefined,
    });

    const result = await service.writeEntryToClipboard(id);

    assert.equal(result.ok, true, '图片复制现在必须真的可用');
    assert.equal(images.length, 1);
    assert.deepEqual(images[0], TINY_PNG);
    assert.equal(selfWrites, 1);
  });

  test('图片文件丢失时返回明确失败，不假装成功', async () => {
    const own = createStore();
    own.store.addImage(TINY_PNG, 1, 1);
    const id = own.store.list({ kind: 'image' })[0]!.id;

    const service = createPasteService({
      store: { getDetail: (entryId) => own.store.getDetail(entryId) },
      clipboard: { writeText: async () => undefined, writeImagePng: async () => ({ ok: true }) },
      readImageBytes: async () => null,
      sendPasteKeys: async () => ({ ok: true }),
      hideAppWindow: async () => undefined,
      showAppWindow: () => undefined,
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
      wait: async () => undefined,
    });

    const result = await service.writeEntryToClipboard(id);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /图片文件已丢失/);
  });

  test('原生剪贴板写入失败时把原因透传给用户', async () => {
    const own = createStore();
    own.store.addImage(TINY_PNG, 1, 1);
    const id = own.store.list({ kind: 'image' })[0]!.id;

    const service = createPasteService({
      store: { getDetail: (entryId) => own.store.getDetail(entryId) },
      clipboard: {
        writeText: async () => undefined,
        writeImagePng: async () => ({ ok: false, error: 'PowerShell 不可用' }),
      },
      readImageBytes: async () => TINY_PNG,
      sendPasteKeys: async () => ({ ok: true }),
      hideAppWindow: async () => undefined,
      showAppWindow: () => undefined,
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
      wait: async () => undefined,
    });

    const result = await service.writeEntryToClipboard(id);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /PowerShell 不可用/);
  });
});

describe('粘贴到前台窗口 — 模式与降级', () => {
  test('copyOnly 模式不隐藏窗口、不发送按键，且不算失败', async () => {
    const own = createStore();
    const id = own.store.addText('仅复制模式').entry!.id;
    const windowEvents: string[] = [];

    let sendKeysCalled = false;
    const service = createPasteService({
      store: { getDetail: (entryId) => own.store.getDetail(entryId) },
      clipboard: { writeText: async () => undefined, writeImagePng: async () => ({ ok: true }) },
      readImageBytes: async () => null,
      sendPasteKeys: async () => {
        sendKeysCalled = true;
        return { ok: true };
      },
      hideAppWindow: async () => {
        windowEvents.push('hide');
      },
      showAppWindow: () => {
        windowEvents.push('show');
      },
      onSelfWrite: () => undefined,
      getPasteMode: () => 'copyOnly',
      wait: async () => undefined,
    });

    const result = await service.pasteEntryToActiveWindow(id);

    assert.equal(result.ok, true, '仅复制是用户的选择，不是失败');
    assert.equal(result.autoPasted, false);
    assert.equal(result.mode, 'copyOnly');
    assert.deepEqual(windowEvents, [], '仅复制模式不应动窗口');
    assert.equal(sendKeysCalled, false, '仅复制模式不应发送按键');
  });

  test('auto 模式：隐藏窗口 → 等焦点回落 → 发送按键 → 恢复窗口', async () => {
    const h = createHarness({ mode: 'auto' });
    const own = createStore();
    const id = own.store.addText('自动粘贴').entry!.id;

    const service = createPasteService({
      store: { getDetail: (entryId) => own.store.getDetail(entryId) },
      clipboard: { writeText: async () => undefined, writeImagePng: async () => ({ ok: true }) },
      readImageBytes: async () => null,
      sendPasteKeys: async () => ({ ok: true }),
      hideAppWindow: async () => {
        h.windowEvents.push('hide');
      },
      showAppWindow: () => {
        h.windowEvents.push('show');
      },
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
      wait: async (ms) => {
        h.focusWaits.push(ms);
      },
    });

    const result = await service.pasteEntryToActiveWindow(id);

    assert.equal(result.ok, true);
    assert.equal(result.autoPasted, true, '这一步现在必须真的完成自动粘贴');
    assert.deepEqual(h.windowEvents, ['hide', 'show'], '必须先隐藏再恢复窗口');
    assert.ok((h.focusWaits[0] ?? 0) > 0, '隐藏后必须等待焦点回落，否则会粘贴到自己身上');
  });

  test('发送按键失败时降级为「已复制 + 提示手动粘贴」，不谎报已粘贴', async () => {
    const h = createHarness();
    const own = createStore();
    const id = own.store.addText('提权窗口场景').entry!.id;

    const service = createPasteService({
      store: { getDetail: (entryId) => own.store.getDetail(entryId) },
      clipboard: { writeText: async () => undefined, writeImagePng: async () => ({ ok: true }) },
      readImageBytes: async () => null,
      sendPasteKeys: async () => ({ ok: false, error: '目标窗口以管理员权限运行，无法注入按键' }),
      hideAppWindow: async () => {
        h.windowEvents.push('hide');
      },
      showAppWindow: () => {
        h.windowEvents.push('show');
      },
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
      wait: async () => undefined,
    });

    const result = await service.pasteEntryToActiveWindow(id);

    assert.equal(result.ok, true, '复制已成功，整体不算失败');
    assert.equal(result.autoPasted, false, '不得谎报已经粘贴');
    assert.match(result.notice ?? '', /管理员权限/);
    assert.deepEqual(h.windowEvents, ['hide', 'show'], '失败也要把窗口还回来');
  });

  test('复制失败时整体失败，且不触碰窗口', async () => {
    const h = createHarness();
    const service = createPasteService({
      store: { getDetail: () => null },
      clipboard: { writeText: async () => undefined, writeImagePng: async () => ({ ok: true }) },
      readImageBytes: async () => null,
      sendPasteKeys: async () => ({ ok: true }),
      hideAppWindow: async () => {
        h.windowEvents.push('hide');
      },
      showAppWindow: () => {
        h.windowEvents.push('show');
      },
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
      wait: async () => undefined,
    });

    const result = await service.pasteEntryToActiveWindow('不存在');

    assert.equal(result.ok, false);
    assert.equal(result.autoPasted, false);
    assert.deepEqual(h.windowEvents, [], '复制都没成功就不该动窗口');
  });

  test('隐藏窗口本身抛错时如实说明原因，且不误调「恢复窗口」', async () => {
    const own = createStore();
    const id = own.store.addText('隐藏失败场景').entry!.id;
    const windowEvents: string[] = [];

    const service = createPasteService({
      store: { getDetail: (entryId) => own.store.getDetail(entryId) },
      clipboard: { writeText: async () => undefined, writeImagePng: async () => ({ ok: true }) },
      readImageBytes: async () => null,
      sendPasteKeys: async () => ({ ok: true }),
      hideAppWindow: async () => {
        throw new Error('隐藏窗口失败');
      },
      showAppWindow: () => {
        windowEvents.push('show');
      },
      onSelfWrite: () => undefined,
      getPasteMode: () => 'auto',
      wait: async () => undefined,
    });

    const result = await service.pasteEntryToActiveWindow(id);

    assert.equal(result.ok, true, '复制成功，整体仍是成功');
    assert.equal(result.autoPasted, false);
    assert.match(result.notice ?? '', /隐藏窗口失败/);
    // 隐藏根本没成功，窗口本就可见，因此**不该**再调 show（否则会意外把窗口拉到前台）
    assert.deepEqual(windowEvents, [], '未成功隐藏就不应调用显示');
  });
});
