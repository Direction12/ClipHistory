/**
 * 剪贴板写回（复制）。
 *
 * 唯一真源：docs/需求规格说明书.md FR-06（防自触发）、docs/技术方案.md C-05。
 *
 * **Electron 44 的写回是异步的**：`writeText()` 等返回 Promise，
 * 且 `writeImage()` 已被移除（见 C-05）。
 * 本阶段（Phase 4）实现**文本**写回；图片写回依赖 Phase 5 的修订方案，
 * 此处必须返回明确的失败原因，不得假装成功（契约纪律 5）。
 */

import type {
  ClipEntryDetail,
  OperationResult,
  PasteMode,
  PasteResult,
  PasteService,
} from '../shared/types';

/** 与 Electron 44 `clipboard` 对齐的最小写入接口（异步） */
export interface ElectronClipboardWriter {
  writeText(text: string): Promise<void> | void;
}

/** paste 只需要「按 id 取详情」这一项能力（最小权限） */
export interface EntryDetailReader {
  getDetail(id: string): ClipEntryDetail | null;
}

export interface PasteServiceOptions {
  readonly store: EntryDetailReader;
  readonly clipboard: ElectronClipboardWriter;
  /**
   * 通知采集器「接下来这次剪贴板变化是本应用自己写回的」，避免被记成新条目（FR-06）。
   * 原计划的「剪贴板序列号」判据在 Electron 44 已不可用（见 D-15），
   * 因此改由这里显式声明。
   */
  readonly onSelfWrite: () => void;
  /** 当前粘贴模式；用于 `paste:toActive` 返回给界面的提示 */
  readonly getPasteMode: () => PasteMode;
}

/** 图片写回尚未实现时给出的固定说明（Phase 5 完成后删除） */
const IMAGE_PASTE_PENDING = '图片写回将在后续版本提供（Electron 44 已移除 writeImage）';

export function createPasteService(options: PasteServiceOptions): PasteService {
  const { store, clipboard, onSelfWrite, getPasteMode } = options;

  /**
   * 把某条历史写回剪贴板。
   * 成功前**不**调用 onSelfWrite：写失败却提前声明自写回，会让真正的外部复制被漏记。
   */
  async function writeEntry(id: string): Promise<OperationResult> {
    const detail = store.getDetail(id);
    if (detail === null) {
      return { ok: false, error: '该条目可能已被删除，请刷新列表' };
    }

    if (detail.kind === 'image') {
      return { ok: false, error: IMAGE_PASTE_PENDING };
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
    writeEntryToClipboard: writeEntry,

    async pasteEntryToActiveWindow(id: string): Promise<PasteResult> {
      const mode = getPasteMode();
      const copied = await writeEntry(id);

      if (!copied.ok) {
        return { ok: false, mode, autoPasted: false, error: copied.error };
      }

      // 「仅复制」模式下不尝试自动粘贴，这是用户的选择，不是失败
      if (mode === 'copyOnly') {
        return { ok: true, mode, autoPasted: false };
      }

      // 自动粘贴（模拟 Ctrl+V）在 Phase 5 实现。
      // 现在如实告知「已复制，需手动粘贴」，而不是假装已经粘贴。
      return {
        ok: true,
        mode,
        autoPasted: false,
        notice: '已复制到剪贴板；自动粘贴将在后续版本提供，请按 Ctrl+V',
      };
    },
  };
}
