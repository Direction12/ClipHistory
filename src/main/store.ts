/**
 * 剪贴板历史存储层（索引 + 文本全文 + 图片文件）。
 *
 * 唯一真源：docs/存储与数据格式规范.md。
 * 设计要点：
 * - 索引是**追加式 NDJSON**：同一 id 后写的行覆盖先写的行（读取时折叠）。
 *   好处是追加为 O(1) 且崩溃最多丢最后一行；代价是冗余，故需要压缩。
 * - 文本全文单独存 `content/<id>.txt`，索引只留预览，保证列表加载快。
 * - 图片按内容哈希命名，天然去重与跨条目复用。
 * - 单行损坏只跳过该行，绝不让整库不可用。
 *
 * 本模块不依赖 Electron，可在 node:test 里直接用临时目录测试。
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INDEX_COMPACT_THRESHOLD, MAX_ENTRIES, TRASH_TTL_MS } from '../shared/constants';
import type { ClipEntryDetail, ClipEntryMeta, EntryFilter, ImageMeta } from '../shared/types';
import { buildPreview, containsQuery, hashImage, hashText, normalizeText, shouldIgnoreText, truncateText } from './content';
import { ensureDataDirs, isSafeRelativePath, moveFileIfExists, readTextIfExists, removeFileIfExists, resolveDataPaths, writeFileAtomic, type DataPaths } from './paths';

/** 索引行的原始形态：合法字段之外一律忽略 */
interface IndexRow {
  id: string;
  kind: 'text' | 'image';
  hash: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  textPreview?: string;
  truncated?: boolean;
  image?: ImageMeta;
}

export interface AddResult {
  /** null 表示该输入被忽略规则丢弃（空文本等） */
  readonly entry: ClipEntryMeta | null;
  /** true 表示命中去重窗口，未新增也没有改动任何数据 */
  readonly skippedAsDuplicate: boolean;
}

export interface ListOptions {
  readonly query?: string;
  readonly kind?: EntryFilter;
}

export interface CleanupResult {
  readonly removedEntryIds: readonly string[];
  readonly removedImageFiles: readonly string[];
}

/** 搜索时最多读取多少条全文，防止极端情况下把磁盘读爆（见 docs/技术方案.md §7） */
const SEARCH_READ_LIMIT = 2000;

/** 读文件的并发批次大小 */
const READ_BATCH_SIZE = 32;

function createEntryId(timestamp: number): string {
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把一行 JSON 收敛为 IndexRow；不合格返回 null（调用方跳过该行）。
 * 索引文件按不可信输入处理：字段类型不对一律丢弃该行。
 */
function parseIndexRow(value: unknown): IndexRow | null {
  if (!isRecord(value)) {
    return null;
  }

  const { id, kind, hash, createdAt, updatedAt, pinned, textPreview, truncated, image } = value;

  if (typeof id !== 'string' || id === '') return null;
  if (kind !== 'text' && kind !== 'image') return null;
  if (typeof hash !== 'string' || hash === '') return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  if (typeof pinned !== 'boolean') return null;

  const row: IndexRow = { id, kind, hash, createdAt, updatedAt, pinned };

  if (typeof textPreview === 'string') {
    row.textPreview = textPreview;
  }
  if (typeof truncated === 'boolean') {
    row.truncated = truncated;
  }

  if (kind === 'image') {
    // 图片条目没有合法 image 元数据就没有意义，直接丢弃该行
    if (!isRecord(image)) return null;
    const { file, width, height, sizeBytes } = image;
    if (typeof file !== 'string' || !isSafeRelativePath(file)) return null;
    if (typeof width !== 'number' || !Number.isFinite(width)) return null;
    if (typeof height !== 'number' || !Number.isFinite(height)) return null;
    if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes)) return null;
    row.image = { file, width, height, sizeBytes };
  }

  return row;
}

function compareByUpdatedAtDesc(a: ClipEntryMeta, b: ClipEntryMeta): number {
  if (b.updatedAt !== a.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  // 时间相同用 id 兜底，保证排序稳定可预期
  return a.id.localeCompare(b.id);
}

export interface ClipStoreOptions {
  readonly paths?: DataPaths;
  /** 可注入时钟，便于测试去重窗口与过期判定 */
  readonly now?: () => number;
  /**
   * 安排一次「暂存区过期清理」。默认用 unref 的 setTimeout 自己定闹钟，
   * 测试可注入假实现以便断言「删除后确实排了清理」。
   */
  readonly schedulePurge?: (entryId: string) => void;
}

/** 一条待撤销记录：暂存了哪些文件、什么时候可以抹掉 */
interface PendingTrashRecord {
  expiresAt: number;
  readonly files: string[];
}

export class ClipStore {
  private readonly paths: DataPaths;
  private readonly now: () => number;

  /** 折叠后的索引：id → 元数据 */
  private entries = new Map<string, ClipEntryMeta>();

  /** 索引文件当前的行数（用于判断是否值得压缩） */
  private indexLineCount = 0;

  /** 加载过程中跳过的坏行数，供诊断 */
  private damagedLineCount = 0;

  /**
   * 去重窗口由设置决定；此处不直接依赖 settings 模块以免循环依赖，
   * 故通过一个惰性提供者注入（main 里接 settings，测试里可固定）。
   */
  private dedupWindowMsProvider: () => number = () => 5000;

  /**
   * 待撤销的暂存登记：条目 id → 暂存了哪些文件、何时可抹。
   *
   * **只在内存里**：进程一重启就没有「待撤销会话」了，因此 `init()` 会清空整个
   * 暂存目录（见 docs/存储与数据格式规范.md §7.2）。
   */
  private pendingTrash = new Map<string, PendingTrashRecord>();

  private readonly schedulePurge: (entryId: string) => void;

  constructor(options: ClipStoreOptions = {}) {
    this.paths = options.paths ?? resolveDataPaths();
    this.now = options.now ?? (() => Date.now());
    this.schedulePurge =
      options.schedulePurge ??
      (() => {
        const timer = setTimeout(() => {
          this.purgeExpiredTrash();
        }, TRASH_TTL_MS + 1000);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      });
  }

  get dataPaths(): DataPaths {
    return this.paths;
  }

  /** 跳过损坏行的数量；用于「损坏行不影响其余数据」的验证 */
  get damagedLines(): number {
    return this.damagedLineCount;
  }

  get currentIndexLineCount(): number {
    return this.indexLineCount;
  }

  /**
   * 初始化：建目录、读索引并折叠。
   * 单行损坏只跳过并计数，不影响其余数据（T-02）。
   */
  init(): void {
    ensureDataDirs(this.paths);
    // 启动即清空暂存区：新进程不存在待撤销会话，上一个进程崩溃/退出留下的文件必须抹掉
    this.purgeTrash();
    this.reloadFromDisk();
  }

  /** 从磁盘重新读取索引（init 与测试用） */
  reloadFromDisk(): void {
    this.entries = new Map<string, ClipEntryMeta>();
    this.indexLineCount = 0;
    this.damagedLineCount = 0;

    const raw = readTextIfExists(this.paths.indexFile);
    if (raw === null) {
      return;
    }

    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }

      this.indexLineCount += 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // 损坏行（含写入中断留下的半行）只跳过
        this.damagedLineCount += 1;
        continue;
      }

      const row = parseIndexRow(parsed);
      if (row === null) {
        this.damagedLineCount += 1;
        continue;
      }

      // 后出现的行覆盖先前的行
      this.entries.set(row.id, this.toMeta(row));
    }
  }

  private toMeta(row: IndexRow): ClipEntryMeta {
    const meta: ClipEntryMeta = {
      id: row.id,
      kind: row.kind,
      hash: row.hash,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      pinned: row.pinned,
    };
    if (row.textPreview !== undefined) {
      (meta as { textPreview?: string }).textPreview = row.textPreview;
    }
    if (row.truncated !== undefined) {
      (meta as { truncated?: boolean }).truncated = row.truncated;
    }
    if (row.image !== undefined) {
      (meta as { image?: ImageMeta }).image = row.image;
    }
    return meta;
  }

  private toRow(meta: ClipEntryMeta): IndexRow {
    const row: IndexRow = {
      id: meta.id,
      kind: meta.kind,
      hash: meta.hash,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      pinned: meta.pinned,
    };
    if (meta.textPreview !== undefined) {
      row.textPreview = meta.textPreview;
    }
    if (meta.truncated !== undefined) {
      row.truncated = meta.truncated;
    }
    if (meta.image !== undefined) {
      row.image = meta.image;
    }
    return row;
  }

  private appendRow(meta: ClipEntryMeta): void {
    ensureDataDirs(this.paths);
    appendFileSync(this.paths.indexFile, `${JSON.stringify(this.toRow(meta))}\n`, 'utf8');
    this.indexLineCount += 1;
    this.entries.set(meta.id, meta);
    this.compactIfRedundant();
  }

  /** 冗余达到阈值时压缩，避免索引无限增长 */
  private compactIfRedundant(): void {
    if (this.indexLineCount > INDEX_COMPACT_THRESHOLD && this.indexLineCount > this.entries.size * 2) {
      this.compact();
    }
  }

  /**
   * 压缩：把折叠后的唯一记录重写为干净索引。
   * 先写 .tmp 再原子替换，中途崩溃时原文件完好（见 docs/存储与数据格式规范.md §3.3）。
   */
  compact(): void {
    const sorted = Array.from(this.entries.values()).sort(compareByUpdatedAtDesc);
    const contents = sorted.map((meta) => `${JSON.stringify(this.toRow(meta))}\n`).join('');
    ensureDataDirs(this.paths);
    writeFileAtomic(this.paths.indexFile, contents);
    this.indexLineCount = sorted.length;
  }

  // ---------- 写入 ----------

  /** 记录一段文本；重复内容按去重窗口决定「忽略」或「刷新时间」 */
  addText(rawText: string, timestamp: number = this.now()): AddResult {
    if (shouldIgnoreText(rawText)) {
      return { entry: null, skippedAsDuplicate: false };
    }

    const normalized = normalizeText(rawText);
    const hash = hashText(normalized);
    const existing = this.findByHash('text', hash);
    const dedupWindowMs = this.dedupWindowMsProvider();

    if (existing !== null) {
      if (timestamp - existing.updatedAt < dedupWindowMs) {
        return { entry: existing, skippedAsDuplicate: true };
      }
      const refreshed: ClipEntryMeta = { ...existing, updatedAt: timestamp };
      this.appendRow(refreshed);
      return { entry: refreshed, skippedAsDuplicate: false };
    }

    const { text, truncated } = truncateText(normalized);
    const id = createEntryId(timestamp);

    writeFileSync(join(this.paths.contentDir, `${id}.txt`), text, 'utf8');

    const meta: ClipEntryMeta = {
      id,
      kind: 'text',
      hash,
      createdAt: timestamp,
      updatedAt: timestamp,
      pinned: false,
      textPreview: buildPreview(text),
      truncated,
    };

    this.appendRow(meta);
    this.enforceEntryLimit();
    return { entry: meta, skippedAsDuplicate: false };
  }

  /** 记录一张图片（PNG 字节）；按内容哈希去重并复用文件 */
  addImage(pngBytes: Buffer, width: number, height: number, timestamp: number = this.now()): AddResult {
    const hash = hashImage(pngBytes);
    const existing = this.findByHash('image', hash);
    const dedupWindowMs = this.dedupWindowMsProvider();

    if (existing !== null) {
      if (timestamp - existing.updatedAt < dedupWindowMs) {
        return { entry: existing, skippedAsDuplicate: true };
      }
      const refreshed: ClipEntryMeta = { ...existing, updatedAt: timestamp };
      this.appendRow(refreshed);
      return { entry: refreshed, skippedAsDuplicate: false };
    }

    const relativePath = `images/${hash}.png`;
    const absolutePath = join(this.paths.imagesDir, `${hash}.png`);

    // 同一图片文件可能已被其它条目引用（哈希命名），内容相同则无需重写
    if (!existsSync(absolutePath)) {
      ensureDataDirs(this.paths);
      writeFileSync(absolutePath, pngBytes);
    }

    const id = createEntryId(timestamp);
    const meta: ClipEntryMeta = {
      id,
      kind: 'image',
      hash,
      createdAt: timestamp,
      updatedAt: timestamp,
      pinned: false,
      image: { file: relativePath, width, height, sizeBytes: pngBytes.length },
    };

    this.appendRow(meta);
    this.enforceEntryLimit();
    return { entry: meta, skippedAsDuplicate: false };
  }

  /**
   * 去重窗口由设置决定；此处不直接依赖 settings 模块以免循环依赖，
   * 故通过一个惰性提供者注入（main 里接 settings，测试里可固定）。
   */
  setDedupWindowProvider(provider: () => number): void {
    this.dedupWindowMsProvider = provider;
  }

  private findByHash(kind: 'text' | 'image', hash: string): ClipEntryMeta | null {
    for (const meta of this.entries.values()) {
      if (meta.kind === kind && meta.hash === hash) {
        return meta;
      }
    }
    return null;
  }

  // ---------- 读取 ----------

  /**
   * 列表：按 updatedAt 降序；可按类型筛选与关键词搜索。
   *
   * 返回的每一项都会带上「内容是否仍在磁盘上」的标记（`textAvailable` /
   * `imageAvailable`）—— 界面需要据此显示「全文已丢失 / 图片已丢失」，
   * 而不是给用户一个点了没反应的空卡片（见 docs/设计规范.md §5）。
   */
  list(options: ListOptions = {}): ClipEntryMeta[] {
    const kind = options.kind ?? 'all';
    const query = (options.query ?? '').trim();
    const lowerCaseQuery = query.toLowerCase();

    const byKind = Array.from(this.entries.values()).filter(
      (meta) => kind === 'all' || meta.kind === kind,
    );

    if (lowerCaseQuery === '') {
      return byKind.sort(compareByUpdatedAtDesc).map((meta) => this.withAvailability(meta));
    }

    // 先按预览粗筛，命中的直接保留；其余再读全文精确匹配（空白差异会让预览与全文不一致）
    const hits: ClipEntryMeta[] = [];
    const candidates: ClipEntryMeta[] = [];

    for (const meta of byKind) {
      if (meta.kind === 'text' && containsQuery(meta.textPreview ?? '', lowerCaseQuery)) {
        hits.push(meta);
      } else {
        candidates.push(meta);
      }
    }

    const inspectTargets = candidates.slice(0, SEARCH_READ_LIMIT);
    for (let offset = 0; offset < inspectTargets.length; offset += READ_BATCH_SIZE) {
      const batch = inspectTargets.slice(offset, offset + READ_BATCH_SIZE);
      for (const meta of batch) {
        if (meta.kind !== 'text') {
          continue;
        }
        const fullText = this.readText(meta.id);
        if (fullText !== null && containsQuery(fullText, lowerCaseQuery)) {
          hits.push(meta);
        }
      }
    }

    return hits.sort(compareByUpdatedAtDesc).map((meta) => this.withAvailability(meta));
  }

  /** 附上「内容文件是否仍在」的标记，供界面显示丢失提示 */
  private withAvailability(meta: ClipEntryMeta): ClipEntryMeta {
    if (meta.kind === 'text') {
      const contentFile = join(this.paths.contentDir, `${meta.id}.txt`);
      return { ...meta, textAvailable: existsSync(contentFile) };
    }
    const imageFile = this.imageAbsolutePath(meta);
    return { ...meta, imageAvailable: imageFile !== null };
  }

  /** 读取文本全文；不存在时返回 null（条目仍在，界面显示「全文已丢失」） */
  readText(id: string): string | null {
    return readTextIfExists(join(this.paths.contentDir, `${id}.txt`));
  }

  /** 读取图片绝对路径；文件不存在时返回 null（界面显示占位图） */
  imageAbsolutePath(meta: ClipEntryMeta): string | null {
    const relative = meta.image?.file;
    if (relative === undefined) {
      return null;
    }
    return this.imageAbsolutePathFromRelative(relative);
  }

  /**
   * 按索引里的相对路径解析出图片绝对路径。
   *
   * 用于「写回剪贴板」等需要读取图片字节的场景；路径仍走 `isSafeRelativePath`
   * 校验，确保相对路径无法越出数据目录（见 docs/编码规范.md §2）。
   */
  imageAbsolutePathFromRelative(relativePath: string): string | null {
    if (!isSafeRelativePath(relativePath)) {
      return null;
    }
    const absolute = join(this.paths.root, relativePath);
    return existsSync(absolute) ? absolute : null;
  }

  getDetail(id: string): ClipEntryDetail | null {
    const meta = this.entries.get(id);
    if (meta === null || meta === undefined) {
      return null;
    }
    if (meta.kind !== 'text') {
      return { ...meta };
    }
    const text = this.readText(id);
    return text === null ? { ...meta } : { ...meta, text };
  }

  get(id: string): ClipEntryMeta | null {
    return this.entries.get(id) ?? null;
  }

  /** 摘要：用于冒烟自检与诊断，不含任何剪贴板内容 */
  stats(): { entries: number; text: number; image: number; pinned: number; damagedLines: number } {
    let text = 0;
    let image = 0;
    let pinned = 0;
    for (const meta of this.entries.values()) {
      if (meta.kind === 'text') text += 1;
      else image += 1;
      if (meta.pinned) pinned += 1;
    }
    return { entries: this.entries.size, text, image, pinned, damagedLines: this.damagedLineCount };
  }

  // ---------- 条目操作 ----------

  setPinned(id: string, pinned: boolean, timestamp: number = this.now()): ClipEntryMeta | null {
    const meta = this.entries.get(id);
    if (meta === undefined) {
      return null;
    }
    const updated: ClipEntryMeta = { ...meta, pinned, updatedAt: timestamp };
    this.appendRow(updated);
    return updated;
  }

  /**
   * 删除条目：文件**搬进暂存区**而不是当场抹掉，撤销窗口内可原样找回。
   *
   * 诚实说明：这叫「延迟删除」，不是「软删除标记」——索引里该条已经消失，
   * 只是原始文件还在 `trash/` 里等撤销窗口过去（见 docs/存储与数据格式规范.md §7.2）。
   */
  remove(id: string): boolean {
    const meta = this.entries.get(id);
    if (meta === undefined) {
      return false;
    }

    // 先把文件搬到暂存区：搬移失败只意味着「内容已丢失」，不影响索引一致性
    const files = this.moveFilesToTrash(meta);

    // 用墓碑行标记删除（不追加特殊行，直接从索引移除需重写；这里直接压缩最干净）
    this.entries.delete(id);
    this.compact();
    this.collectOrphanImages();

    if (files.length > 0) {
      this.pendingTrash.set(id, { expiresAt: this.now() + TRASH_TTL_MS, files });
      this.schedulePurge(id);
    }
    return true;
  }

  /**
   * 把条目占用的文件搬进暂存区，返回暂存的文件名清单。
   *
   * 两种必须留心的情形：
   * 1. 内容本来就已丢失 → 返回空数组，删除照常完成（不留待撤销的假象）；
   * 2. 图片按内容哈希命名，**可能被多个条目共用**——只要还有别的条目引用它，
   *    就绝不能搬走，否则删掉一条会把另一条的图也弄丢。
   */
  private moveFilesToTrash(meta: ClipEntryMeta): string[] {
    const moved: string[] = [];

    if (meta.kind === 'text') {
      const fileName = `${meta.id}.txt`;
      if (moveFileIfExists(join(this.paths.contentDir, fileName), join(this.paths.trashDir, fileName))) {
        moved.push(fileName);
      }
      return moved;
    }

    const imageName = this.imageFileName(meta);
    if (imageName === null || this.isImageReferencedByOthers(imageName, meta.id)) {
      return moved;
    }
    if (moveFileIfExists(join(this.paths.imagesDir, imageName), join(this.paths.trashDir, imageName))) {
      moved.push(imageName);
    }
    return moved;
  }

  /** 取图片条目的文件名（不含目录）；元数据缺失或路径不安全时返回 null */
  private imageFileName(meta: ClipEntryMeta): string | null {
    const relative = meta.image?.file;
    if (relative === undefined || !isSafeRelativePath(relative)) {
      return null;
    }
    const name = relative.split(/[\\/]/).pop() ?? '';
    return name === '' ? null : name;
  }

  /** 除 exceptId 之外是否还有条目引用同一张图片文件 */
  private isImageReferencedByOthers(fileName: string, exceptId: string): boolean {
    for (const [id, meta] of this.entries) {
      if (id === exceptId) {
        continue;
      }
      if (this.imageFileName(meta) === fileName) {
        return true;
      }
    }
    return false;
  }

  /**
   * 撤销删除：先尽量从暂存区搬回原始文件（保字节），再补写全文，最后把索引行加回去。
   *
   * 三种情形都要能正确落地：
   * - 暂存文件还在 → 原样搬回，图片缩略图立即恢复；
   * - 已过撤销窗口（文件已抹）→ 文字按传入全文重建，图片保持「已丢失」并由界面明示；
   * - 图片是与别的条目共用的同一张 → 文件从未被搬走，无需还原。
   */
  restore(detail: ClipEntryDetail): ClipEntryMeta {
    ensureDataDirs(this.paths);
    this.restoreFilesFromTrash(detail);

    if (detail.kind === 'text' && detail.text !== undefined) {
      const target = join(this.paths.contentDir, `${detail.id}.txt`);
      if (!existsSync(target)) {
        writeFileSync(target, detail.text, 'utf8');
      }
    }

    this.pendingTrash.delete(detail.id);

    const meta: ClipEntryMeta = { ...detail };
    delete (meta as { text?: string }).text;
    this.appendRow(meta);
    return meta;
  }

  /** 从暂存区把条目文件搬回原位；文件不在暂存区时安静返回 */
  private restoreFilesFromTrash(detail: ClipEntryDetail): void {
    if (detail.kind === 'text') {
      const fileName = `${detail.id}.txt`;
      moveFileIfExists(join(this.paths.trashDir, fileName), join(this.paths.contentDir, fileName));
      return;
    }
    const imageName = this.imageFileName(detail);
    if (imageName !== null) {
      moveFileIfExists(join(this.paths.trashDir, imageName), join(this.paths.imagesDir, imageName));
    }
  }

  /**
   * 清空暂存区（启动时调用），返回抹掉的文件数。
   *
   * 进程重启后不存在「待撤销会话」，所以这里不做任何时间判断，一律清空。
   */
  purgeTrash(): number {
    this.pendingTrash.clear();
    if (!existsSync(this.paths.trashDir)) {
      return 0;
    }
    let removed = 0;
    for (const name of readdirSync(this.paths.trashDir)) {
      removeFileIfExists(join(this.paths.trashDir, name));
      removed += 1;
    }
    return removed;
  }

  /**
   * 抹掉已过撤销窗口的暂存文件，返回抹掉的文件数。
   *
   * 判定只看内存登记的 `expiresAt`，**绝不看文件时间**：`rename` 会保留原 mtime，
   * 一张几天前复制的图刚搬进暂存区就会被误判成过期而当场抹掉。
   */
  purgeExpiredTrash(now: number = this.now()): number {
    let removed = 0;
    for (const [entryId, record] of Array.from(this.pendingTrash)) {
      if (record.expiresAt > now) {
        continue;
      }
      for (const name of record.files) {
        removeFileIfExists(join(this.paths.trashDir, name));
        removed += 1;
      }
      this.pendingTrash.delete(entryId);
    }
    return removed;
  }

  /** 暂存区里待撤销的条目数（诊断与测试用） */
  get pendingTrashCount(): number {
    return this.pendingTrash.size;
  }

  /** 清空：保留置顶条目，返回被移除的数量 */
  clear(keepPinned = true): { removed: number } {
    const toRemove = Array.from(this.entries.values()).filter((meta) => !(keepPinned && meta.pinned));
    for (const meta of toRemove) {
      this.entries.delete(meta.id);
      removeFileIfExists(join(this.paths.contentDir, `${meta.id}.txt`));
    }
    this.compact();
    this.collectOrphanImages();
    return { removed: toRemove.length };
  }

  /**
   * 清理过期条目：未置顶且 updatedAt 早于 cutoff 的全部移除。
   * 置顶条目**永不**参与自动清理（见 docs/需求规格说明书.md FR-12）。
   */
  cleanupExpired(cutoff: number): CleanupResult {
    const removedEntryIds: string[] = [];

    for (const meta of Array.from(this.entries.values())) {
      if (meta.pinned) continue;
      if (meta.updatedAt >= cutoff) continue;
      removedEntryIds.push(meta.id);
      this.entries.delete(meta.id);
      removeFileIfExists(join(this.paths.contentDir, `${meta.id}.txt`));
    }

    if (removedEntryIds.length > 0) {
      this.compact();
    }
    const removedImageFiles = this.collectOrphanImages();

    return { removedEntryIds, removedImageFiles };
  }

  /**
   * 回收孤儿图片：删除不再被任何条目引用的 images/*.png。
   *
   * 为什么先压缩：压缩后的索引才是「当前有效引用」的准确依据，
   * 否则可能依据含冗余旧行的索引误判（见 docs/存储与数据格式规范.md §7 安全要求）。
   *
   * 只扫 `images/`，因此不会碰到暂存区 `trash/`：待撤销的文件不在「有效引用」的
   * 判定范围内，但仍必须活到撤销窗口结束（见 §7.2）。
   */
  collectOrphanImages(): string[] {
    if (!existsSync(this.paths.imagesDir)) {
      return [];
    }

    const referenced = new Set<string>();
    for (const meta of this.entries.values()) {
      if (meta.image !== undefined) {
        referenced.add(meta.image.file.replace(/^images[\\/]/, ''));
      }
    }

    const removed: string[] = [];
    for (const fileName of readdirSync(this.paths.imagesDir)) {
      if (!fileName.endsWith('.png')) continue;
      if (referenced.has(fileName)) continue;
      removeFileIfExists(join(this.paths.imagesDir, fileName));
      removed.push(fileName);
    }
    return removed;
  }

  /** 条目上限兜底：优先收起最旧的未置顶条目；全为置顶时停止并返回 0 */
  enforceEntryLimit(): number {
    if (this.entries.size <= MAX_ENTRIES) {
      return 0;
    }

    const removable = Array.from(this.entries.values())
      .filter((meta) => !meta.pinned)
      .sort((a, b) => a.updatedAt - b.updatedAt);

    let removedCount = 0;
    while (this.entries.size > MAX_ENTRIES && removedCount < removable.length) {
      const victim = removable[removedCount];
      if (victim === undefined) break;
      this.entries.delete(victim.id);
      removeFileIfExists(join(this.paths.contentDir, `${victim.id}.txt`));
      removedCount += 1;
    }

    if (removedCount > 0) {
      this.compact();
      this.collectOrphanImages();
    }
    return removedCount;
  }

  // ---------- 测试接缝 ----------

  /**
   * 测试接缝：直接替换内存索引，用于构造「条目上限 / 压缩阈值」这类
   * 无法靠真实 I/O 高效铺出的大规模场景（P2-05 的 T-11）。
   * 生产代码不得调用。
   */
  replaceEntriesForTest(entries: readonly ClipEntryMeta[]): void {
    this.entries = new Map(entries.map((meta) => [meta.id, meta]));
  }

  /** 测试接缝：直接向索引文件追加一行，用于构造「同一 id 多行」与「损坏行」场景 */
  appendRowForTest(meta: ClipEntryMeta): void {
    this.appendRow(meta);
  }

  /**
   * 测试接缝：把去重窗口强制设为 0，使「内容相同」不再被时间窗口吸收。
   *
   * 用途：集成自检要在无真实复制的情况下连续落库；若沿用默认 5 秒窗口，
   * 两次采集会因时间戳相同而被判为重复动作。生产代码不得调用。
   */
  disableDedupForTest(): void {
    this.dedupWindowMsProvider = () => 0;
  }
}
