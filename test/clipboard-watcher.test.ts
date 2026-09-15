/**
 * 剪贴板采集器单元测试 —— 覆盖 docs/测试与验收标准.md 的 T-05 与
 * FR-01~FR-06、FR-06 防自触发、D-09 启动不采集陈旧内容。
 *
 * 关键：本测试**不接触真实剪贴板**，通过注入假数据源把
 * 「什么时候该记录、什么时候该跳过」的判定完全覆盖。
 * 真实剪贴板行为（Electron 44 异步 clipboard 适配）列入手动验收清单。
 *
 * 注意：采集器接口是**异步**的（Electron 44 剪贴板 API 变更，见技术方案 C-05），
 * 因此所有 poll() 都需要 await。
 *
 * 运行方式：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClipboardWatcher,
  createElectronClipboardSource,
  parsePngSize,
  type ClipboardItemLike,
  type ClipboardPayload,
  type CapturedContent,
  type ElectronClipboardLike,
} from '../src/main/clipboard-watcher';
import { TINY_PNG } from './helpers/paths';

/** 可编程的假剪贴板：测试通过 setText / setImage 模拟用户复制 */
class FakeClipboardSource {
  private text = '';
  private pngBytes: Buffer | null = null;
  private width = 0;
  private height = 0;
  private sequence = 0;
  /** 设为 true 时模拟读取抛异常，用于验证单次失败不打断轮询 */
  public throwOnRead = false;

  setText(text: string): void {
    this.text = text;
    this.pngBytes = null;
    this.sequence += 1;
  }

  setImage(bytes: Buffer, width: number, height: number): void {
    this.pngBytes = bytes;
    this.width = width;
    this.height = height;
    this.text = '';
    this.sequence += 1;
  }

  clear(): void {
    this.text = '';
    this.pngBytes = null;
    this.sequence += 1;
  }

  async readSequence(): Promise<number | null> {
    if (this.throwOnRead) {
      throw new Error('模拟剪贴板读取失败');
    }
    return this.sequence;
  }

  async readPayload(): Promise<ClipboardPayload> {
    if (this.throwOnRead) {
      throw new Error('模拟剪贴板读取失败');
    }
    return {
      text: this.text,
      imagePngBytes: this.pngBytes,
      imageWidth: this.width,
      imageHeight: this.height,
    };
  }
}

async function createWatcher() {
  const source = new FakeClipboardSource();
  const captured: CapturedContent[] = [];
  const errors: unknown[] = [];
  const watcher = new ClipboardWatcher({
    source,
    onCapture: (content) => captured.push(content),
    onError: (error) => errors.push(error),
  });
  return { source, captured, errors, watcher };
}

describe('采集器 — 发现新内容（FR-01 / FR-02 / FR-03）', () => {
  test('复制新文本后记录一次', async () => {
    const { source, captured, watcher } = await createWatcher();
    await watcher.primeBaseline();

    source.setText('第一条内容');
    assert.equal(await watcher.poll(), 'captured-text');

    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.kind, 'text');
    assert.equal(captured[0]?.text, '第一条内容');
  });

  test('复制截图后记录为图片，并带回宽高与 PNG 字节', async () => {
    const { source, captured, watcher } = await createWatcher();
    await watcher.primeBaseline();

    source.setImage(TINY_PNG, 1920, 1080);
    assert.equal(await watcher.poll(), 'captured-image');

    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.kind, 'image');
    assert.equal(captured[0]?.imageWidth, 1920);
    assert.equal(captured[0]?.imageHeight, 1080);
    assert.deepEqual(captured[0]?.imagePngBytes, TINY_PNG);
  });

  test('连续两次不同内容分别记录', async () => {
    const { source, captured, watcher } = await createWatcher();
    await watcher.primeBaseline();

    source.setText('内容一');
    await watcher.poll();
    source.setText('内容二');
    await watcher.poll();

    assert.deepEqual(
      captured.map((item) => item.text),
      ['内容一', '内容二'],
    );
  });
});

describe('采集器 — 不重复记录（FR-04 / FR-06）', () => {
  test('内容未变化时反复轮询不会重复记录', async () => {
    const { source, captured, watcher } = await createWatcher();
    await watcher.primeBaseline();

    source.setText('同一段内容');
    await watcher.poll();
    // 剪贴板内容与序列号都没变，之后三轮都应被跳过
    assert.equal(await watcher.poll(), 'skipped-sequence-unchanged');
    assert.equal(await watcher.poll(), 'skipped-sequence-unchanged');
    assert.equal(await watcher.poll(), 'skipped-sequence-unchanged');

    assert.equal(captured.length, 1);
  });

  test('序列号变了但内容相同也不会记录（交给 store 的去重窗口判定）', async () => {
    const { source, captured, watcher } = await createWatcher();
    await watcher.primeBaseline();

    source.setText('内容 X');
    await watcher.poll();

    // 模拟另一个程序重设了同样的内容：序列号变化，内容不变
    source.setText('内容 X');
    assert.equal(await watcher.poll(), 'skipped-content-unchanged');

    assert.equal(captured.length, 1);
  });

  test('markSelfWrite 后的一轮变化被跳过（防自触发）', async () => {
    const { source, captured, watcher } = await createWatcher();
    await watcher.primeBaseline();

    // 模拟应用把历史内容写回剪贴板
    watcher.markSelfWrite();
    source.setText('被本应用写回的内容');
    assert.equal(await watcher.poll(), 'skipped-self-write');
    assert.equal(captured.length, 0, '自己写回的内容不得被记录');

    // 只跳过一轮：之后用户真正复制的内容必须照常记录
    source.setText('用户后来复制的内容');
    assert.equal(await watcher.poll(), 'captured-text');
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.text, '用户后来复制的内容');
  });

  test('markSelfWrite 的抑制只生效一次', async () => {
    const { source, captured, watcher } = await createWatcher();
    await watcher.primeBaseline();

    watcher.markSelfWrite();
    source.setText('A');
    await watcher.poll();
    source.setText('B');
    await watcher.poll();

    assert.deepEqual(
      captured.map((item) => item.text),
      ['B'],
      '只应记录第二个内容',
    );
  });
});

describe('采集器 — 忽略规则（FR-05）', () => {
  test('空内容、纯空白、仅换行都不记录', async () => {
    const { source, captured, watcher } = await createWatcher();
    await watcher.primeBaseline();

    // 注意：三种空白内容必须**互不相同**，否则第二、三次会被
    // 「内容未变化」提前拦截，就走不到空白判定这条分支了。
    source.setText('   ');
    assert.equal(await watcher.poll(), 'skipped-blank-text');
    source.setText('\n\n  \r\n');
    assert.equal(await watcher.poll(), 'skipped-blank-text');
    source.setText('\t\t');
    assert.equal(await watcher.poll(), 'skipped-blank-text');
    source.setText('');
    assert.equal(await watcher.poll(), 'skipped-blank-text');

    assert.equal(captured.length, 0);
  });

  test('清空剪贴板（内容从有到无）不产生记录', async () => {
    const { source, captured, watcher } = await createWatcher();
    await watcher.primeBaseline();

    source.setText('先有一条内容');
    await watcher.poll();
    source.clear();
    assert.equal(await watcher.poll(), 'skipped-blank-text');

    assert.equal(captured.length, 1, '只应有最初那一条');
  });

  test('ignoreBlankText=false 时空白内容也会被记录', async () => {
    const source = new FakeClipboardSource();
    const captured: CapturedContent[] = [];
    const watcher = new ClipboardWatcher({
      source,
      onCapture: (content) => captured.push(content),
      ignoreBlankText: false,
    });
    await watcher.primeBaseline();

    source.setText('  ');
    assert.equal(await watcher.poll(), 'captured-text');
    assert.equal(captured.length, 1);
  });
});

describe('采集器 — 启动不采集陈旧内容（D-09）', () => {
  test('primeBaseline 后剪贴板里已有内容不会被记录', async () => {
    const { source, captured, watcher } = await createWatcher();

    // 模拟启动前剪贴板里就躺着的内容
    source.setImage(TINY_PNG, 10, 10);
    source.setText('启动前的文本');

    await watcher.primeBaseline();

    assert.equal(await watcher.poll(), 'skipped-sequence-unchanged');
    assert.equal(captured.length, 0, '启动前的陈旧内容不得进历史');

    // 之后的真实复制仍要记录
    source.setText('启动后复制的内容');
    await watcher.poll();
    assert.equal(captured.length, 1);
  });

  test('未调用 primeBaseline 时，首轮会把已有内容视作新复制', async () => {
    const { source, captured, watcher } = await createWatcher();
    source.setText('未建基线时会被记录');

    assert.equal(await watcher.poll(), 'captured-text');
    assert.equal(captured.length, 1, '这是 primeBaseline 必要性的反证');
  });
});

describe('采集器 — 暂停与启停', () => {
  test('暂停期间不读剪贴板、不记录', async () => {
    const { source, captured, watcher } = await createWatcher();
    await watcher.primeBaseline();

    watcher.setPaused(true);
    source.setText('暂停期间复制的内容');
    assert.equal(await watcher.poll(), 'skipped-paused');
    assert.equal(captured.length, 0);

    watcher.setPaused(false);
    assert.equal(await watcher.poll(), 'captured-text', '恢复后应记录');
  });

  test('start/stop 幂等且状态可查', async () => {
    const { watcher } = await createWatcher();
    assert.equal(watcher.isRunning, false);

    watcher.start();
    assert.equal(watcher.isRunning, true);
    watcher.start(); // 重复调用无副作用
    assert.equal(watcher.isRunning, true);

    watcher.stop();
    assert.equal(watcher.isRunning, false);
    watcher.stop(); // 重复停止无副作用
    assert.equal(watcher.isRunning, false);
  });
});

describe('采集器 — 异常不打断轮询', () => {
  test('读取抛异常时通过 onError 上报，且不记录内容', async () => {
    const { source, captured, errors, watcher } = await createWatcher();
    await watcher.primeBaseline();

    source.throwOnRead = true;
    await watcher.poll();

    assert.ok(errors.length > 0, '异常必须上报，不能静默吞掉');
    assert.equal(captured.length, 0);

    // 恢复后仍能正常工作
    source.throwOnRead = false;
    source.setText('恢复后的内容');
    await watcher.poll();
    assert.equal(captured.length, 1);
  });

  test('onCapture 抛异常不会让 poll 崩溃', async () => {
    const source = new FakeClipboardSource();
    const watcher = new ClipboardWatcher({
      source,
      onCapture: () => {
        throw new Error('模拟落库失败');
      },
    });
    await watcher.primeBaseline();
    source.setText('会触发落库失败的内容');

    await assert.doesNotReject(async () => {
      await watcher.poll();
    });
  });
});

describe('PNG 宽高解析（D-14）', () => {
  test('真实 PNG 能解析出宽高', () => {
    const size = parsePngSize(TINY_PNG);
    assert.deepEqual(size, { width: 1, height: 1 }, '内置的 1×1 PNG');
  });

  test('非 PNG 数据返回 null 而不是抛错', () => {
    assert.equal(parsePngSize(Buffer.from('这不是 PNG 文件内容，只是一段普通文本而已')), null);
  });

  test('数据过短返回 null', () => {
    assert.equal(parsePngSize(Buffer.from([0x89, 0x50])), null);
  });

  test('签名正确但 IHDR 缺失时返回 null', () => {
    const broken = Buffer.from(TINY_PNG);
    broken[12] = 0x58; // 破坏 "IHDR" 的首字母
    assert.equal(parsePngSize(broken), null);
  });
});

describe('采集器 — Electron 44 异步 clipboard 适配器（C-05）', () => {
  /** 构造一个模拟 Electron 剪贴板项的假对象 */
  function makeItem(types: string[], blobs: Record<string, Buffer>): ClipboardItemLike {
    return {
      types,
      getType: async (type: string) => {
        const bytes = blobs[type];
        if (bytes === undefined) {
          throw new Error(`不支持的格式 ${type}`);
        }
        return {
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        };
      },
    };
  }

  function makeClipboard(text: string, items: ClipboardItemLike[]): ElectronClipboardLike {
    return {
      readText: async () => text,
      read: async () => items,
    };
  }

  test('无图片时只返回文本', async () => {
    const source = createElectronClipboardSource(makeClipboard('纯文本', []));

    const payload = await source.readPayload();
    assert.equal(payload.text, '纯文本');
    assert.equal(payload.imagePngBytes, null);
    assert.equal(await source.readSequence(), null, '序列号判据已不可用，应返回 null');
  });

  test('按 MIME 类型取出图片字节并解析出宽高', async () => {
    const source = createElectronClipboardSource(
      makeClipboard('', [makeItem(['image/png'], { 'image/png': TINY_PNG })]),
    );

    const payload = await source.readPayload();
    assert.deepEqual(payload.imagePngBytes, TINY_PNG);
    assert.equal(payload.imageWidth, 1, '宽高应来自自行解析的 PNG 头部');
    assert.equal(payload.imageHeight, 1);
  });

  test('多个项时跳过不支持的项，取到图片为止', async () => {
    const source = createElectronClipboardSource(
      makeClipboard('', [
        makeItem(['text/html'], { 'text/html': Buffer.from('<b>x</b>') }),
        makeItem(['image/png'], { 'image/png': TINY_PNG }),
      ]),
    );

    const payload = await source.readPayload();
    assert.deepEqual(payload.imagePngBytes, TINY_PNG);
  });

  test('声明了 image/png 但取不出来时降级为纯文本，不让整轮失败', async () => {
    const source = createElectronClipboardSource(
      makeClipboard('旁边的文本', [makeItem(['image/png'], {})]),
    );

    const payload = await source.readPayload();
    assert.equal(payload.imagePngBytes, null);
    assert.equal(payload.text, '旁边的文本');
  });
});
