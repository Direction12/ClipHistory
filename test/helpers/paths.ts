/**
 * 单元测试共用工具：临时数据目录的建立与清理。
 *
 * 为什么必须自建自清：`npm test` 使用 `--experimental-test-isolation=none`，
 * 所有用例跑在同一进程内，没有进程级隔离。因此每个用例都必须拥有自己的
 * 临时目录，并且用完立刻删除，绝不能共用可变状态
 * （见 docs/技术方案.md C-03 与 docs/测试与验收标准.md §3）。
 *
 * 注意：入口必须在**消费方测试文件**里调用，因为 `node --test` 只把测试文件
 * 当作入口执行；从测试文件 import 本模块时它不会被单独当成测试运行。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDataPaths, type DataPaths } from '../../src/main/paths';
import { ClipStore, type ClipStoreOptions } from '../../src/main/store';
import type { ClipEntryMeta } from '../../src/shared/types';

/** 建立本次用例专属的临时数据目录 */
export function createTempDataPaths(): DataPaths {
  const root = mkdtempSync(join(tmpdir(), 'cliphistory-test-'));
  return resolveDataPaths(root);
}

/** 删除本次用例的临时数据目录；失败不抛出（临时目录残留不应让测试变红） */
export function removeTempDataPaths(paths: DataPaths): void {
  try {
    rmSync(paths.root, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

export function directoryExists(path: string): boolean {
  return existsSync(path);
}

export interface TestStoreHandle {
  readonly store: ClipStore;
  readonly paths: DataPaths;
  /** 推进可注入时钟的当前时间（毫秒） */
  advance(ms: number): void;
  now(): number;
  dispose(): void;
}

/**
 * 建立一个带可注入时钟的 store。
 * 起始时间取固定值，确保断言可预期，且不依赖真实时间流逝（不用 setTimeout 等待）。
 */
export function createTestStore(options: { startTime?: number; dataPaths?: DataPaths } = {}): TestStoreHandle {
  const paths = options.dataPaths ?? createTempDataPaths();
  let currentTime = options.startTime ?? 1_756_000_000_000;

  const storeOptions: ClipStoreOptions = {
    paths,
    now: () => currentTime,
  };
  const store = new ClipStore(storeOptions);
  store.init();

  return {
    store,
    paths,
    advance: (ms: number) => {
      currentTime += ms;
    },
    now: () => currentTime,
    dispose: () => removeTempDataPaths(paths),
  };
}

/** 造一条最小可用的文本条目元数据，用于测试接缝场景 */
export function makeTextEntry(
  id: string,
  updatedAt: number,
  overrides: Partial<ClipEntryMeta> = {},
): ClipEntryMeta {
  return {
    id,
    kind: 'text',
    hash: `hash-${id}`,
    createdAt: updatedAt,
    updatedAt,
    pinned: false,
    textPreview: `预览-${id}`,
    ...overrides,
  };
}

/** 一段最小合法 PNG（1×1 像素），用于图片相关测试 */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
