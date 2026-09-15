/**
 * settings 单元测试 —— 对应 docs/测试与验收标准.md §2 的 T-15、T-16。
 *
 * 运行方式（见 docs/构建与运行.md §2.4）：
 *   node --test --experimental-test-isolation=none "test/*.test.ts"
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  coerceSettings,
  defaultSettings,
  loadSettings,
  saveSettings,
  updateSettings,
} from '../src/main/settings';
import { DEFAULT_DEDUP_WINDOW_MS, DEFAULT_RETENTION_DAYS } from '../src/shared/constants';
import type { PasteMode } from '../src/shared/types';
import { createTempDataPaths, removeTempDataPaths } from './helpers/paths';

const cleanups: Array<() => void> = [];
after(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
});

function tempPaths() {
  const paths = createTempDataPaths();
  cleanups.push(() => {
    removeTempDataPaths(paths);
  });
  return paths;
}

describe('设置校验 — 逐字段回退（T-15）', () => {
  test('空对象得到全部默认值', () => {
    const { settings } = coerceSettings({});
    assert.deepEqual(settings, defaultSettings());
  });

  test('retentionDays 越界或类型错误各自回退，不影响其它字段', () => {
    for (const invalid of [0, -1, 366, 9999, 1.5, '3', null, undefined, Number.NaN]) {
      const { settings, warnings } = coerceSettings({
        retentionDays: invalid,
        pasteMode: 'copyOnly',
      });
      assert.equal(settings.retentionDays, DEFAULT_RETENTION_DAYS, `输入 ${String(invalid)} 应回退`);
      assert.equal(settings.pasteMode, 'copyOnly', '其它合法字段必须保留');
      assert.ok(warnings.length > 0, '回退必须产生告警，不能静默');
    }
  });

  test('retentionDays 合法边界值被接受', () => {
    assert.equal(coerceSettings({ retentionDays: 1 }).settings.retentionDays, 1);
    assert.equal(coerceSettings({ retentionDays: 365 }).settings.retentionDays, 365);
  });

  test('dedupWindowMs 越界回退', () => {
    assert.equal(coerceSettings({ dedupWindowMs: -1 }).settings.dedupWindowMs, DEFAULT_DEDUP_WINDOW_MS);
    assert.equal(coerceSettings({ dedupWindowMs: 60001 }).settings.dedupWindowMs, DEFAULT_DEDUP_WINDOW_MS);
    assert.equal(coerceSettings({ dedupWindowMs: 'fast' }).settings.dedupWindowMs, DEFAULT_DEDUP_WINDOW_MS);
    // 边界值 0 是合法的：表示不做去重
    assert.equal(coerceSettings({ dedupWindowMs: 0 }).settings.dedupWindowMs, 0);
  });

  test('pasteMode 非法枚举回退为 auto', () => {
    assert.equal(coerceSettings({ pasteMode: 'whatever' }).settings.pasteMode, 'auto');
    assert.equal(coerceSettings({ pasteMode: 123 }).settings.pasteMode, 'auto');
    assert.equal(coerceSettings({ pasteMode: 'copyOnly' }).settings.pasteMode, 'copyOnly');
  });

  test('paused 非布尔回退为 false', () => {
    assert.equal(coerceSettings({ paused: 'yes' }).settings.paused, false);
    assert.equal(coerceSettings({ paused: true }).settings.paused, true);
  });

  test('windowBounds 任一字段非法则整块回退', () => {
    const fallback = defaultSettings().windowBounds;

    assert.deepEqual(coerceSettings({ windowBounds: { x: 1, y: 2, width: 0, height: 10 } }).settings.windowBounds, fallback);
    assert.deepEqual(coerceSettings({ windowBounds: { x: 1, y: 2, width: -5, height: 10 } }).settings.windowBounds, fallback);
    assert.deepEqual(coerceSettings({ windowBounds: { x: 1, y: 2, width: 100 } }).settings.windowBounds, fallback);
    assert.deepEqual(coerceSettings({ windowBounds: 'fullscreen' }).settings.windowBounds, fallback);
    assert.deepEqual(coerceSettings({ windowBounds: { x: 1, y: 2, width: 300, height: Number.NaN } }).settings.windowBounds, fallback);

    const valid = { x: 10, y: 20, width: 500, height: 700 };
    assert.deepEqual(coerceSettings({ windowBounds: valid }).settings.windowBounds, valid);
  });

  test('整个内容不是对象时整份回退并告警', () => {
    for (const raw of [[], 'text', 42, true]) {
      const { settings, warnings } = coerceSettings(raw);
      assert.deepEqual(settings, defaultSettings());
      assert.ok(warnings.length > 0);
    }
  });

  test('外部无法通过 seed 改写 version', () => {
    const { settings } = coerceSettings({ version: 999, retentionDays: 5 });
    assert.equal(settings.version, 1);
    assert.equal(settings.retentionDays, 5);
  });
});

describe('设置持久化 — 读写与原子写入（T-16）', () => {
  test('文件不存在时返回默认值且不产生告警', () => {
    const paths = tempPaths();
    const { settings, warnings } = loadSettings(paths);

    assert.deepEqual(settings, defaultSettings());
    assert.equal(warnings.length, 0, '首次运行不应刷无意义的告警');
  });

  test('写入后可回读，字段一致', () => {
    const paths = tempPaths();
    const custom = { ...defaultSettings(), retentionDays: 5, pasteMode: 'copyOnly' as const, paused: true };

    saveSettings(custom, paths);
    const { settings, warnings } = loadSettings(paths);

    assert.deepEqual(settings, custom);
    assert.equal(warnings.length, 0);
  });

  test('写入使用临时文件 + 原子替换，不留下 .tmp 残留', () => {
    const paths = tempPaths();
    saveSettings({ ...defaultSettings(), retentionDays: 7 }, paths);

    const raw = readFileSync(paths.settingsFile, 'utf8');
    assert.ok(raw.endsWith('\n'), '文件应以换行结尾');
    assert.doesNotThrow(() => JSON.parse(raw) as unknown, '落盘内容必须是合法 JSON');
    assert.throws(
      () => readFileSync(`${paths.settingsFile}.tmp`, 'utf8'),
      /ENOENT/,
      '临时文件应已被 rename 掉',
    );
  });

  test('设置文件损坏时整份回退，不抛异常', () => {
    const paths = tempPaths();
    writeFileSync(paths.settingsFile, '{ 这不是合法 JSON', 'utf8');

    const { settings, warnings } = loadSettings(paths);

    assert.deepEqual(settings, defaultSettings());
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /无法解析/);
  });

  test('部分字段损坏时只回退该字段，其余合法字段保留', () => {
    const paths = tempPaths();
    writeFileSync(
      paths.settingsFile,
      JSON.stringify({ retentionDays: 9999, pasteMode: 'copyOnly', paused: true, windowBounds: { x: 3, y: 4, width: 400, height: 500 } }),
      'utf8',
    );

    const { settings } = loadSettings(paths);

    assert.equal(settings.retentionDays, DEFAULT_RETENTION_DAYS, '非法字段回退');
    assert.equal(settings.pasteMode, 'copyOnly', '合法字段保留');
    assert.equal(settings.paused, true);
    assert.deepEqual(settings.windowBounds, { x: 3, y: 4, width: 400, height: 500 });
  });

  test('updateSettings 合并式更新并落盘，未指定字段保持不变', () => {
    const paths = tempPaths();
    saveSettings({ ...defaultSettings(), retentionDays: 5, paused: true }, paths);

    const { settings } = updateSettings({ pasteMode: 'copyOnly' }, paths);

    assert.equal(settings.pasteMode, 'copyOnly', '新值生效');
    assert.equal(settings.retentionDays, 5, '未指定的字段应保持');
    assert.equal(settings.paused, true, '未指定的字段应保持');

    assert.equal(loadSettings(paths).settings.pasteMode, 'copyOnly', '更新必须落盘');
  });

  test('updateSettings 的非法入参也会被校验（IPC 入参不可信）', () => {
    const paths = tempPaths();
    // 故意绕过类型检查：模拟渲染层经 IPC 送来的不可信数据
    const untrusted = { retentionDays: -5, pasteMode: 'nope' } as unknown as { retentionDays: number; pasteMode: PasteMode };
    const { settings, warnings } = updateSettings(untrusted, paths);

    assert.equal(settings.retentionDays, DEFAULT_RETENTION_DAYS);
    assert.equal(settings.pasteMode, 'auto');
    assert.ok(warnings.length >= 2);
  });
});
