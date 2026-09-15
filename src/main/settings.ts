/**
 * 设置读写与逐字段校验。
 *
 * 唯一真源：docs/存储与数据格式规范.md §2。
 * 核心纪律：**逐字段独立校验**，非法值回退默认值并记录 warning，
 * 绝不因为单个字段非法而丢弃整个配置文件。
 */

import { DATA_FORMAT_VERSION, DEFAULT_DEDUP_WINDOW_MS, DEFAULT_RETENTION_DAYS, DEDUP_WINDOW_MAX_MS, DEDUP_WINDOW_MIN_MS, RETENTION_MAX_DAYS, RETENTION_MIN_DAYS } from '../shared/constants';
import type { PasteMode, Settings, WindowBounds } from '../shared/types';
import { ensureDataDirs, readTextIfExists, resolveDataPaths, writeFileAtomic, type DataPaths } from './paths';

export const DEFAULT_WINDOW_BOUNDS: WindowBounds = {
  x: 100,
  y: 100,
  width: 420,
  height: 640,
};

/** 默认设置；任何字段回退时都以这里的值为准 */
export function defaultSettings(): Settings {
  return {
    version: DATA_FORMAT_VERSION,
    retentionDays: DEFAULT_RETENTION_DAYS,
    dedupWindowMs: DEFAULT_DEDUP_WINDOW_MS,
    pasteMode: 'auto',
    paused: false,
    windowBounds: { ...DEFAULT_WINDOW_BOUNDS },
  };
}

/** 更新入参：version 不由界面决定，禁止外部覆盖 */
export type SettingsSeed = Partial<Omit<Settings, 'version'>>;

/** 校验过程中的告警，供调用方记录日志（不在此处直接写日志，便于测试断言） */
export interface SettingsLoadResult {
  readonly settings: Settings;
  readonly warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceIntegerInRange(value: unknown, min: number, max: number, fallback: number, field: string, warnings: string[]): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  warnings.push(`字段 ${field} 非法（${JSON.stringify(value)}），已回退为 ${String(fallback)}`);
  return fallback;
}

function coercePasteMode(value: unknown, warnings: string[]): PasteMode {
  if (value === 'auto' || value === 'copyOnly') {
    return value;
  }
  warnings.push(`字段 pasteMode 非法（${JSON.stringify(value)}），已回退为 auto`);
  return 'auto';
}

function coerceBoolean(value: unknown, fallback: boolean, field: string, warnings: string[]): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  warnings.push(`字段 ${field} 非法（${JSON.stringify(value)}），已回退为 ${String(fallback)}`);
  return fallback;
}

/** 窗口位置整块校验：任一字段非法就整块回退，避免「半有效」的窗口尺寸 */
function coerceWindowBounds(value: unknown, warnings: string[]): WindowBounds {
  if (isRecord(value)) {
    const { x, y, width, height } = value;
    const numbersValid =
      typeof x === 'number' && Number.isFinite(x) &&
      typeof y === 'number' && Number.isFinite(y) &&
      typeof width === 'number' && Number.isFinite(width) &&
      typeof height === 'number' && Number.isFinite(height);

    if (numbersValid && width > 0 && height > 0) {
      return { x, y, width, height };
    }
  }
  warnings.push('字段 windowBounds 非法，已整块回退为默认值');
  return { ...DEFAULT_WINDOW_BOUNDS };
}

/**
 * 把任意未知输入收敛为合法 Settings。
 * 导出以便单元测试直接覆盖各字段的非法场景（T-15）。
 */
export function coerceSettings(raw: unknown): SettingsLoadResult {
  const warnings: string[] = [];
  const fallback = defaultSettings();

  if (!isRecord(raw)) {
    if (raw !== null && raw !== undefined) {
      warnings.push('设置文件内容不是对象，已整份回退为默认值');
    }
    return { settings: fallback, warnings };
  }

  return {
    settings: {
      version: DATA_FORMAT_VERSION,
      retentionDays: coerceIntegerInRange(raw.retentionDays, RETENTION_MIN_DAYS, RETENTION_MAX_DAYS, fallback.retentionDays, 'retentionDays', warnings),
      dedupWindowMs: coerceIntegerInRange(raw.dedupWindowMs, DEDUP_WINDOW_MIN_MS, DEDUP_WINDOW_MAX_MS, fallback.dedupWindowMs, 'dedupWindowMs', warnings),
      pasteMode: coercePasteMode(raw.pasteMode, warnings),
      paused: coerceBoolean(raw.paused, fallback.paused, 'paused', warnings),
      windowBounds: coerceWindowBounds(raw.windowBounds, warnings),
    },
    warnings,
  };
}

/** 读取设置。文件不存在或内容损坏都返回默认值 + 告警，不抛异常 */
export function loadSettings(paths: DataPaths = resolveDataPaths()): SettingsLoadResult {
  const raw = readTextIfExists(paths.settingsFile);
  if (raw === null) {
    return { settings: defaultSettings(), warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { settings: defaultSettings(), warnings: [`设置文件无法解析（${reason}），已整份回退为默认值`] };
  }

  return coerceSettings(parsed);
}

/** 原子写入设置 */
export function saveSettings(settings: Settings, paths: DataPaths = resolveDataPaths()): void {
  ensureDataDirs(paths);
  writeFileAtomic(paths.settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * 合并更新：把 seed 与现有设置合并后再校验一遍。
 *
 * 为什么要再校验：调用方可能来自 IPC（渲染层数据不可信），
 * 校验放在这里兜底，与 docs/编码规范.md §6 的「入参必须校验」一致。
 */
export function updateSettings(
  seed: SettingsSeed,
  paths: DataPaths = resolveDataPaths(),
): SettingsLoadResult {
  const current = loadSettings(paths);
  const merged = coerceSettings({ ...current.settings, ...seed });
  saveSettings(merged.settings, paths);
  return merged;
}
