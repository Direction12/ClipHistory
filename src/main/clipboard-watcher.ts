/**
 * 剪贴板采集器：轮询剪贴板，把新的文字/图片交给回调记录。
 *
 * 唯一真源：docs/需求规格说明书.md FR-01~FR-06、docs/技术方案.md D-01/D-09/D-13~D-15。
 *
 * **重要：全部剪贴板访问都是异步的。** Electron 44 的 `clipboard` 已改为异步 API
 * （`readText()` / `read()` / `has()` 返回 Promise），且旧同步/图片方法
 * `readImage()` / `writeImage()` / `availableFormats()` **已被移除**（运行时实测为 undefined）。
 * 详见 docs/技术方案.md 平台约束 C-05。
 *
 * 设计要点（都是为了可测）：
 * - **依赖注入**：剪贴板读取与落库回调全部由外部传入，本模块不 import electron，
 *   因此纯逻辑可在 `node:test` 里完整覆盖（无 GUI、无真实剪贴板）。
 * - **只负责"发现变化"**：去重窗口与忽略规则最终以 store 为准，这里只做
 *   「与上一轮相比内容是否变化」这一层最省的判断，避免同一内容反复落库。
 * - **启动时不采集已有内容**（D-09）：必须显式调用 `primeBaseline()`。
 */

import { CLIPBOARD_POLL_INTERVAL_MS } from '../shared/constants';

/** 从剪贴板读到的一份内容快照 */
export interface ClipboardPayload {
  readonly text: string;
  /** 图片的 PNG 字节；无图片时为 null */
  readonly imagePngBytes: Buffer | null;
  readonly imageWidth: number;
  readonly imageHeight: number;
}

/**
 * 剪贴板数据源。生产实现见 `createElectronClipboardSource`，
 * 测试用假实现模拟各种内容变化。
 */
export interface ClipboardSource {
  /**
   * 当前剪贴板序列号；取不到时返回 null。
   *
   * 该判据是**可选**的：Electron 44 移除了 `availableFormats()`，无法再探测
   * `CF_CLIPBOARD_SEQUENCE` 是否可用（见 D-15）。因此实现应始终允许返回 null，
   * 去重正确性完全由内容比对与 store 的哈希 + 时间窗口保证。
   */
  readSequence(): Promise<number | null>;
  /** 读取当前内容快照 */
  readPayload(): Promise<ClipboardPayload>;
}

/** 一条待记录的内容 */
export interface CapturedContent {
  readonly kind: 'text' | 'image';
  readonly text: string;
  readonly imagePngBytes: Buffer | null;
  readonly imageWidth: number;
  readonly imageHeight: number;
}

export type CaptureHandler = (captured: CapturedContent) => void;

export interface ClipboardWatcherOptions {
  readonly source: ClipboardSource;
  readonly onCapture: CaptureHandler;
  /** 轮询间隔（ms） */
  readonly intervalMs?: number;
  /** 是否记录空白文本（默认不记录，见 FR-05） */
  readonly ignoreBlankText?: boolean;
  /** 采集失败时的日志出口；不传则静默 */
  readonly onError?: (error: unknown) => void;
}

/** 一轮轮询的结果，供测试与诊断使用 */
export type PollOutcome =
  | 'skipped-paused'
  | 'skipped-busy'
  | 'skipped-read-failed'
  | 'skipped-sequence-unchanged'
  | 'skipped-content-unchanged'
  | 'skipped-blank-text'
  | 'skipped-self-write'
  | 'captured-text'
  | 'captured-image';

interface LastSeenState {
  readonly sequence: number | null;
  readonly text: string;
  /** 图片字节的轻量指纹，足够区分不同截图 */
  readonly imageFingerprint: string | null;
}

export class ClipboardWatcher {
  private readonly source: ClipboardSource;
  private readonly onCapture: CaptureHandler;
  private readonly intervalMs: number;
  private readonly ignoreBlankText: boolean;
  private readonly onError: (error: unknown) => void;

  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  private lastSeen: LastSeenState | null = null;
  private suppressNextCycle = false;
  /** 防止上一轮尚未读完时下一轮又进来（异步读取期间可能跨过 tick） */
  private polling = false;

  constructor(options: ClipboardWatcherOptions) {
    this.source = options.source;
    this.onCapture = options.onCapture;
    this.intervalMs = options.intervalMs ?? CLIPBOARD_POLL_INTERVAL_MS;
    this.ignoreBlankText = options.ignoreBlankText ?? true;
    this.onError = options.onError ?? (() => undefined);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** 开始轮询。重复调用无副作用 */
  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
    // 轮询任务不应阻止进程退出
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    void this.poll();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 暂停/恢复采集（托盘菜单用）；暂停期间不读剪贴板 */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /**
   * 建立基线：读完当前剪贴板内容后丢弃，不记录。
   * 启动时必须先调用一次，否则会把启动前的陈旧剪贴板内容当作新复制的内容
   * （见 docs/技术方案.md D-09）。
   */
  async primeBaseline(): Promise<void> {
    this.lastSeen = await this.readCurrentState();
  }

  /**
   * 声明「接下来这一次剪贴板变化是本应用自己写回的」，下一轮跳过不记录。
   *
   * 用途：Phase 5 用户点「复制/粘贴」时，本应用会把内容写回剪贴板；
   * 若不跳过，这条内容会被当成用户新复制的内容再记一次（见 FR-06）。
   */
  markSelfWrite(): void {
    this.suppressNextCycle = true;
  }

  /** 执行一轮轮询；返回本轮判定结果 */
  async poll(): Promise<PollOutcome> {
    if (this.paused) {
      return 'skipped-paused';
    }
    if (this.polling) {
      // 上一轮还没读完（剪贴板操作是异步的），跳过本轮避免叠加
      return 'skipped-busy';
    }

    this.polling = true;
    try {
      return await this.pollOnce();
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<PollOutcome> {
    const sequence = await this.safeReadSequence();
    const payload = await this.safeReadPayload();
    if (payload === null) {
      return 'skipped-read-failed';
    }

    const imageFingerprint = fingerprintImage(payload.imagePngBytes);
    const previous = this.lastSeen;
    const contentUnchanged =
      previous !== null &&
      previous.text === payload.text &&
      previous.imageFingerprint === imageFingerprint;

    // 序列号未变且内容也没变 → 一定没有新的复制动作
    if (previous !== null && sequence !== null && sequence === previous.sequence && contentUnchanged) {
      return 'skipped-sequence-unchanged';
    }

    // 内容没变但序列号变了（同一个内容被重新复制）→ 交给 store 的去重窗口判定
    if (contentUnchanged) {
      return 'skipped-content-unchanged';
    }

    this.lastSeen = { sequence, text: payload.text, imageFingerprint };

    // 优先级：先让本应用自己的写回通过（避免自触发），再判断是否值得记录
    if (this.suppressNextCycle) {
      this.suppressNextCycle = false;
      return 'skipped-self-write';
    }

    try {
      if (payload.imagePngBytes !== null) {
        this.onCapture({
          kind: 'image',
          text: payload.text,
          imagePngBytes: payload.imagePngBytes,
          imageWidth: payload.imageWidth,
          imageHeight: payload.imageHeight,
        });
        return 'captured-image';
      }

      if (this.ignoreBlankText && payload.text.trim() === '') {
        // 清空剪贴板 / 纯空白不应进历史（FR-05）
        return 'skipped-blank-text';
      }

      this.onCapture({
        kind: 'text',
        text: payload.text,
        imagePngBytes: null,
        imageWidth: 0,
        imageHeight: 0,
      });
      return 'captured-text';
    } catch (error) {
      // 单次采集失败不应打断轮询循环
      this.onError(error);
      return 'skipped-read-failed';
    }
  }

  private async readCurrentState(): Promise<LastSeenState> {
    const payload = await this.safeReadPayload();
    return {
      sequence: await this.safeReadSequence(),
      text: payload?.text ?? '',
      imageFingerprint: fingerprintImage(payload?.imagePngBytes ?? null),
    };
  }

  private async safeReadSequence(): Promise<number | null> {
    try {
      return await this.source.readSequence();
    } catch (error) {
      this.onError(error);
      return null;
    }
  }

  private async safeReadPayload(): Promise<ClipboardPayload | null> {
    try {
      return await this.source.readPayload();
    } catch (error) {
      this.onError(error);
      return null;
    }
  }
}

/**
 * 图片轻量指纹：长度 + 首尾若干字节。
 * 目的只是区分「这轮和上轮是不是同一张图」，不需要密码学强度；
 * 真正的内容去重由 store 用 PNG 字节的 SHA-256 完成。
 */
function fingerprintImage(bytes: Buffer | null): string | null {
  if (bytes === null || bytes.length === 0) {
    return null;
  }
  const head = bytes.subarray(0, 8).toString('hex');
  const tail = bytes.subarray(Math.max(0, bytes.length - 8)).toString('hex');
  return `${String(bytes.length)}:${head}:${tail}`;
}

/**
 * 解析 PNG 宽高（读取 IHDR 块）。
 *
 * 为什么要自己解析：Electron 44 移除了从剪贴板读取图片对象的能力，
 * 现在只能拿到原始 PNG 字节，而界面要显示「1920×1080」这类信息（见 设计规范 §5）。
 * PNG 头部结构固定：8 字节签名后紧跟 IHDR，宽高各为 4 字节大端整数（偏移 16 与 20）。
 * 自己解析比引入图像库轻量得多。
 *
 * 解析失败（非 PNG / 数据被截断）时返回 null，由调用方决定如何降级。
 */
export function parsePngSize(bytes: Buffer): { width: number; height: number } | null {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) {
    return null;
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      return null;
    }
  }
  // 偏移 12..15 应为 "IHDR"
  const isIhdr =
    bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
  if (!isIhdr) {
    return null;
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

/** 剪贴板项：与 Electron 的 `ClipboardItem` 结构对齐（仅用到两种成员） */
export interface ClipboardItemLike {
  readonly types: string[];
  /**
   * 取得指定 MIME 类型的数据。
   *
   * 返回类型刻意宽松（`unknown`）：Electron 的签名是
   * `Promise<Blob> | Promise<ClipboardBookmark>`——书的书签类型没有 `arrayBuffer`。
   * 与其用联合类型再强行断言，不如在运行时校验形状（见 `readBlobBytes`），
   * 这样既是类型安全的，也能在真的拿到非二进制数据时优雅降级。
   */
  getType(type: string): Promise<unknown>;
}

/** 与 Electron 44 `clipboard` 对齐的最小接口（异步） */
export interface ElectronClipboardLike {
  readText(): Promise<string>;
  /** 返回剪贴板中的所有项；无内容时为空数组 */
  read(): Promise<ClipboardItemLike[]>;
}

/** 剪贴板中表示 PNG 图片的 MIME 类型 */
const PNG_MIME = 'image/png';

/**
 * 从剪贴板项里取出二进制内容。
 * 只在形状确实像 Blob（有 arrayBuffer 方法）时才转换，否则返回 null 交由调用方降级。
 */
async function readBlobBytes(value: unknown): Promise<Buffer | null> {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { arrayBuffer?: unknown };
  if (typeof candidate.arrayBuffer !== 'function') {
    return null;
  }
  const buffer = await (candidate.arrayBuffer as () => Promise<ArrayBuffer>).call(candidate);
  return Buffer.from(buffer);
}

/**
 * 把 Electron 44 的异步 `clipboard` 适配成 `ClipboardSource`。
 *
 * 图片取法：从剪贴板项里找到 `image/png`，取二进制转字节，再自行解析宽高（D-14）。
 * 若某项取图失败（格式不匹配或返回的不是二进制），继续看下一项；
 * 都没有就当纯文本处理，不让整轮采集失败。
 */
export function createElectronClipboardSource(clipboard: ElectronClipboardLike): ClipboardSource {
  return {
    async readSequence(): Promise<number | null> {
      // Electron 44 已无法探测或读取剪贴板序列号（见 D-15），
      // 统一返回 null，由内容比对承担去重判断。
      return null;
    },

    async readPayload(): Promise<ClipboardPayload> {
      const text = await clipboard.readText();
      const items = await clipboard.read();

      for (const item of items) {
        if (!item.types.includes(PNG_MIME)) {
          continue;
        }
        try {
          const bytes = await readBlobBytes(await item.getType(PNG_MIME));
          if (bytes === null) {
            continue;
          }
          const size = parsePngSize(bytes);
          return {
            text,
            imagePngBytes: bytes,
            imageWidth: size?.width ?? 0,
            imageHeight: size?.height ?? 0,
          };
        } catch {
          // 单项取图失败：继续看下一项
          continue;
        }
      }

      return { text, imagePngBytes: null, imageWidth: 0, imageHeight: 0 };
    },
  };
}
