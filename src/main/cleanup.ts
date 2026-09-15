/**
 * 保留策略的任务编排：把「过期判定」（store 的纯函数核心）与「何时执行」接起来。
 *
 * 唯一真源：docs/需求规格说明书.md FR-12、docs/存储与数据格式规范.md §7。
 * 职责边界：本模块只管**什么时候清理**与**截止时间怎么算**；
 * 「哪些条目该删」「孤儿图片怎么回收」由 store.cleanupExpired 负责（已在 Phase 2 测过）。
 */

import { CLEANUP_INTERVAL_MS } from '../shared/constants';
import type { ClipStore, CleanupResult } from './store';
import type { Settings } from '../shared/types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 计算过期截止时间：`updatedAt` 严格早于该值的未置顶条目会被清理。
 *
 * 边界语义（与 store.cleanupExpired 一致，也已被单测固定）：
 * 恰好等于 cutoff 的条目**保留**，即判定条件是 `updatedAt < cutoff`。
 */
export function calculateCutoff(now: number, retentionDays: number): number {
  return now - retentionDays * MS_PER_DAY;
}

export interface CleanupRun {
  readonly cutoff: number;
  readonly retentionDays: number;
  readonly result: CleanupResult;
}

/**
 * 按设置执行一次清理。置顶条目由 store 内部豁免，这里不需要额外判断。
 * `retentionDays` 非法时不做任何事并返回 null，避免因为一个坏设置删掉用户数据。
 */
export function runCleanup(store: ClipStore, settings: Settings, now: number): CleanupRun | null {
  const { retentionDays } = settings;
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return null;
  }

  const cutoff = calculateCutoff(now, retentionDays);
  return {
    cutoff,
    retentionDays,
    result: store.cleanupExpired(cutoff),
  };
}

export type CleanupTrigger = 'startup' | 'interval' | 'settings-changed';

export interface CleanupSchedulerOptions {
  readonly store: ClipStore;
  /** 取当前设置；每次执行前重新读取，保证设置改动立刻生效 */
  readonly getSettings: () => Settings;
  readonly now?: () => number;
  readonly intervalMs?: number;
  /** 每次清理后的回调，用于日志与通知渲染层刷新 */
  readonly onCleaned?: (run: CleanupRun, trigger: CleanupTrigger) => void;
}

/**
 * 定时清理器。
 *
 * 执行时机（见 docs/存储与数据格式规范.md §7）：
 * 1. 应用启动时；
 * 2. 每 6 小时一次；
 * 3. 设置变更后立即执行一次（期限调短时用户期望马上看到结果）。
 */
export class CleanupScheduler {
  private readonly store: ClipStore;
  private readonly getSettings: () => Settings;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly onCleaned: (run: CleanupRun, trigger: CleanupTrigger) => void;

  private timer: NodeJS.Timeout | null = null;

  constructor(options: CleanupSchedulerOptions) {
    this.store = options.store;
    this.getSettings = options.getSettings;
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = options.intervalMs ?? CLEANUP_INTERVAL_MS;
    this.onCleaned = options.onCleaned ?? (() => undefined);
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** 启动：立即执行一次（对应「应用启动时」），随后按间隔重复 */
  start(): void {
    this.runOnce('startup');

    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      this.runOnce('interval');
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 执行一次清理；返回本次结果（设置非法时为 null） */
  runOnce(trigger: CleanupTrigger): CleanupRun | null {
    const run = runCleanup(this.store, this.getSettings(), this.now());
    if (run !== null) {
      this.onCleaned(run, trigger);
    }
    return run;
  }
}
