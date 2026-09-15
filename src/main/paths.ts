/**
 * 数据目录解析与原子写入工具。
 *
 * 职责：把「文件放在哪」和「怎么安全地写文件」收敛到一处，
 * 使 settings.ts 与 store.ts 不必各自处理 Electron 依赖与写入策略。
 *
 * 测试友好：本模块**只在必要时刻**才 require electron，因此纯逻辑测试
 * （node:test，无 Electron）可以把数据目录指到临时目录后直接使用。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DATA_DIR_ENV_KEY } from '../shared/constants';

/** 数据目录下的子目录名 */
export const SUBDIR_CONTENT = 'content';
export const SUBDIR_IMAGES = 'images';
export const SUBDIR_LOGS = 'logs';
/** 撤销暂存区：删除后暂存原始文件，等撤销窗口过去再抹掉（见 docs/存储与数据格式规范.md §7.2） */
export const SUBDIR_TRASH = 'trash';

/** 索引与设置文件名 */
export const INDEX_FILE = 'index.ndjson';
export const SETTINGS_FILE = 'settings.json';

/** 由外部（测试）显式指定的数据目录覆盖 */
let dataDirOverride: string | null = null;

/** 显式指定数据目录（测试用）。传 null 清除覆盖，回到默认解析逻辑 */
export function setDataDirOverride(directory: string | null): void {
  dataDirOverride = directory;
}

/**
 * 解析数据目录，优先级：
 * 1. 显式覆盖（测试）
 * 2. 环境变量 CLIPHISTORY_DATA_DIR（开发期隔离数据）
 * 3. Electron 的 app.getPath('userData')
 *
 * 注意：默认路径必须是 ASCII（%APPDATA%\ClipHistory），避免中文路径在
 * 打包与日志中的编码问题（见 docs/存储与数据格式规范.md §1）。
 */
export function resolveDataDir(): string {
  if (dataDirOverride !== null) {
    return dataDirOverride;
  }

  const fromEnv = process.env[DATA_DIR_ENV_KEY];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return resolve(fromEnv.trim());
  }

  // 延迟 require：纯逻辑测试环境里没有 electron，走到这里才算使用 Electron 能力
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require('electron') as typeof import('electron');
  return join(electron.app.getPath('userData'));
}

/** 确保数据目录及其子目录存在，返回各路径 */
export interface DataPaths {
  readonly root: string;
  readonly indexFile: string;
  readonly settingsFile: string;
  readonly contentDir: string;
  readonly imagesDir: string;
  readonly logsDir: string;
  readonly trashDir: string;
}

export function resolveDataPaths(root: string = resolveDataDir()): DataPaths {
  return {
    root,
    indexFile: join(root, INDEX_FILE),
    settingsFile: join(root, SETTINGS_FILE),
    contentDir: join(root, SUBDIR_CONTENT),
    imagesDir: join(root, SUBDIR_IMAGES),
    logsDir: join(root, SUBDIR_LOGS),
    trashDir: join(root, SUBDIR_TRASH),
  };
}

export function ensureDataDirs(paths: DataPaths): void {
  for (const directory of [paths.root, paths.contentDir, paths.imagesDir, paths.logsDir, paths.trashDir]) {
    mkdirSync(directory, { recursive: true });
  }
}

/**
 * 原子写入文本：先写临时文件，再 rename 替换。
 *
 * 为什么不用 fsync：Windows 上对目录 fsync 不可移植，而 rename 在同一卷内是原子的，
 * 已足以避免「崩溃后留下半截文件」——这正是本规范要防的问题
 * （见 docs/存储与数据格式规范.md §2 写入纪律）。
 */
export function writeFileAtomic(targetPath: string, contents: string): void {
  const directory = dirname(targetPath);
  mkdirSync(directory, { recursive: true });

  const temporaryPath = `${targetPath}.tmp`;
  writeFileSync(temporaryPath, contents, 'utf8');
  renameSync(temporaryPath, targetPath);
}

/** 读取文本文件；不存在时返回 null（不抛异常，由调用方决定默认行为） */
export function readTextIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf8');
}

/** 删除文件；不存在时静默通过 */
export function removeFileIfExists(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // 文件不存在或已被删除都属于预期情况，不视为错误
  }
}

/**
 * 搬移文件（暂存与还原用）；源文件不存在或搬移失败时返回 false，不抛异常。
 *
 * 优先 `renameSync`：同卷内是原子的，且**保留原 mtime**——这正是「不能按文件时间
 * 判定暂存是否过期」的原因（见 docs/存储与数据格式规范.md §7.2）。
 * 跨卷（EXDEV）时退化为「复制 + 删除」。
 */
export function moveFileIfExists(from: string, to: string): boolean {
  if (!existsSync(from)) {
    return false;
  }
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return true;
  } catch {
    // 跨卷或目标被占用：退化为复制后删除
  }
  try {
    copyFileSync(from, to);
    unlinkSync(from);
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验相对存储路径，防止索引内容越界读出数据目录之外的文件。
 *
 * 索引文件是本地明文，但仍按「不可信输入」处理（见 docs/编码规范.md §2）：
 * 一旦 path 被篡改成 ../../ 或绝对路径，就可能读到用户其它文件。
 */
export function isSafeRelativePath(relativePath: string): boolean {
  if (relativePath.trim() === '') {
    return false;
  }
  // 绝对路径与非正斜杠开头的 Windows 形式一律拒绝
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(relativePath)) {
    return false;
  }
  // 逐段检查，任何一段为 .. 即拒绝
  return !relativePath.split(/[\\/]/).some((segment) => segment === '..');
}
