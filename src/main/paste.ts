/**
 * 剪贴板写回（复制）与自动粘贴。
 *
 * 唯一真源：docs/需求规格说明书.md FR-06/FR-13、docs/技术方案.md C-05、LIM-01。
 *
 * ## 两条经运行时实测得出的关键结论（不要再按「直觉」改回去）
 *
 * 1. **文字**：Electron 的 `clipboard.writeText()` 可用。
 * 2. **图片**：**Electron 自身无法真正写入图片**。`clipboard.write()` 配合
 *    `new (require('electron').ClipboardItem)({ 'image/png': blob })` 会**返回成功但实际没写进去**
 *    （读回时该 ClipboardItem 的 types 为空，`getType('image/png')` 报找不到）。
 *    因此图片必须走 **Windows 原生剪贴板**：PowerShell 加载 PNG → Bitmap → `Clipboard::SetImage`。
 *    实测该方式读回 `has('image/png') === true` 且 PNG 字节可完整还原。
 *
 * ## 自动粘贴
 * 隐藏本窗口 → 等焦点回落到原程序 → 用 PowerShell SendKeys 发送 Ctrl+V。
 * 提权窗口收不到模拟按键（LIM-01），此时如实告知用户手动粘贴，**不假装成功**。
 */

import type {
  ClipEntryDetail,
  OperationResult,
  PasteResult,
  PasteService,
} from '../shared/types';

/** 写回剪贴板的能力；两处实现分别为 Electron（文本）与 Windows 原生（图片） */
export interface ClipboardWriter {
  /** 写文本：Electron 的 writeText */
  writeText(text: string): Promise<void>;
  /**
   * 写图片（PNG 字节）：必须走 Windows 原生剪贴板。
   * 返回失败原因表示未写入成功。
   */
  writeImagePng(pngBytes: Buffer): Promise<OperationResult>;
}

/** 只需要「按 id 取详情」这一项能力（最小权限） */
export interface EntryDetailReader {
  getDetail(id: string): ClipEntryDetail | null;
}

/**
 * 按索引里的相对路径读取图片字节。
 *
 * 为什么需要它：Phase 4 冻结的 IPC 契约只回相对路径（避免把图片数据塞进 IPC），
 * 因此写回图片时需要主进程按路径读文件。抽成接口便于测试注入。
 */
export type ImageBytesReader = (relativePath: string) => Promise<Buffer | null>;

export interface PasteServiceOptions {
  readonly store: EntryDetailReader;
  readonly clipboard: ClipboardWriter;
  readonly readImageBytes: ImageBytesReader;
  /**
   * 发送 Ctrl+V 到**当前前台窗口**。
   *
   * 注意：按键只会送给前台窗口。因此调用方必须在发送前确保焦点已在目标程序上
   * （见 `restoreFocusToPreviousWindow`），否则按键会静默落到错误的窗口 ——
   * 这正是「点粘贴没反应/粘错地方」的根因，见 docs/技术方案.md C-14。
   */
  readonly sendPasteKeys: () => Promise<OperationResult>;
  /** 隐藏本应用窗口，使焦点有机会回落到用户原本的窗口 */
  readonly hideAppWindow: () => Promise<void>;
  /**
   * 隐藏窗口后，**显式**把焦点交还给用户原本的程序。
   *
   * 为什么不能只靠隐藏：实测隐藏我们的窗口后焦点**不会**自动回落（会停在上一个
   * 活跃的其它窗口上，例如浏览器），于是 Ctrl+V 打进浏览器。必须显式切回。
   */
  readonly restoreFocusToPreviousWindow: () => Promise<OperationResult>;
  /** 重新显示本应用窗口（自动粘贴后把界面还回来） */
  readonly showAppWindow: () => void;
  /**
   * 通知采集器「接下来这次剪贴板变化是本应用自己写回的」，避免被记成新条目（FR-06）。
   * 原计划的「剪贴板序列号」判据在 Electron 44 已不可用（见 D-15），故改为显式声明。
   */
  readonly onSelfWrite: () => void;
  readonly wait: (ms: number) => Promise<void>;
}

/** 隐藏窗口后等待焦点回落的时间（ms） */
const FOCUS_HANDOFF_MS = 200;

/** LIM-01：目标窗口无法接收模拟按键时的提示 */
const PASTE_FAILED_HINT = '内容已复制到剪贴板，但未能自动粘贴，请按 Ctrl+V';

export function createPasteService(options: PasteServiceOptions): PasteService {
  const {
    store,
    clipboard,
    readImageBytes,
    sendPasteKeys,
    hideAppWindow,
    restoreFocusToPreviousWindow,
    showAppWindow,
    onSelfWrite,
    wait,
  } = options;

  /**
   * 把某条历史写回剪贴板。
   * 成功前**不**调用 onSelfWrite：写失败却提前声明自写回，会让真正的外部复制被漏记。
   */
  async function writeEntryToClipboard(id: string): Promise<OperationResult> {
    const detail = store.getDetail(id);
    if (detail === null) {
      return { ok: false, error: '该条目可能已被删除，请刷新列表' };
    }

    if (detail.kind === 'image') {
      const relativePath = detail.image?.file;
      if (relativePath === undefined) {
        return { ok: false, error: '该条目的图片信息缺失，无法复制' };
      }

      const pngBytes = await readImageBytes(relativePath);
      if (pngBytes === null) {
        return { ok: false, error: '该图片文件已丢失，无法复制' };
      }

      const written = await clipboard.writeImagePng(pngBytes);
      if (!written.ok) {
        return written;
      }
      onSelfWrite();
      return { ok: true };
    }

    if (detail.text === undefined) {
      return { ok: false, error: '该条目的全文已丢失，无法复制' };
    }

    try {
      await clipboard.writeText(detail.text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // LIM-03：剪贴板被占用时写入可能失败，提示用户重试
      return { ok: false, error: `写入剪贴板失败：${reason}。请稍后重试` };
    }

    onSelfWrite();
    return { ok: true };
  }

  return {
    writeEntryToClipboard,

    async pasteEntryToActiveWindow(id: string): Promise<PasteResult> {
      const copied = await writeEntryToClipboard(id);

      if (!copied.ok) {
        return { ok: false, autoPasted: false, error: copied.error };
      }

      // 自动粘贴前必须先把窗口让出去，否则 Ctrl+V 会打到本应用自己身上
      let hidWindow = false;
      try {
        await hideAppWindow();
        hidWindow = true;
        await wait(FOCUS_HANDOFF_MS);

        // 关键一步：隐藏窗口**不会**让焦点自动回到用户原本的程序，
        // 必须显式切回；否则按键会被静默送到错误的窗口（见 C-14）。
        const focused = await restoreFocusToPreviousWindow();
        if (!focused.ok) {
          return {
            ok: true,
            autoPasted: false,
            notice: `${PASTE_FAILED_HINT}（${focused.error ?? '未能确定目标窗口'}）`,
          };
        }

        const sent = await sendPasteKeys();
        if (!sent.ok) {
          return {
            ok: true,
            autoPasted: false,
            notice: `${PASTE_FAILED_HINT}（${sent.error ?? '按键未能送达'}）`,
          };
        }

        return { ok: true, autoPasted: true };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: true, autoPasted: false, notice: `${PASTE_FAILED_HINT}（${reason}）` };
      } finally {
        // 无论成功失败都要把界面还给用户，否则应用就像消失了一样
        if (hidWindow) {
          showAppWindow();
        }
      }
    },
  };
}
