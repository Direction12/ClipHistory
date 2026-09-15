/**
 * 渲染层入口：装配历史列表、搜索筛选、卡片操作与设置面板。
 *
 * 唯一真源：docs/设计规范.md（视觉与交互）、docs/技术方案.md §5（IPC 契约）。
 *
 * 纪律：
 * - 不直接访问文件系统、不直接操作剪贴板：一切经 `window.clipHistory`（见 §3 进程职责）。
 * - 每个 IPC 调用都要处理 `ok: false`，并向用户说明「为什么」与「下一步」（见 设计规范 §8）。
 * - 文本一律用 textContent 写入，绝不拼接 innerHTML —— 剪贴板内容是不可信输入。
 */

import { RENDERER_API_KEY } from '../shared/constants';

type ClipFilter = 'all' | 'text' | 'image';

/** 通过共享常量取 API（避免把挂载名写死在两处） */
function api(): ClipHistoryBridge {
  return (window as unknown as Record<string, ClipHistoryBridge>)[RENDERER_API_KEY];
}

// ---------- 界面状态 ----------

let currentFilter: ClipFilter = 'all';
let currentQuery = '';
let currentEntries: ClipEntryMeta[] = [];
let currentSettings: ClipSettings | null = null;
/** 删除撤销：记录被删条目与定时器，5 秒后放弃撤销机会 */
let pendingUndo: { entry: ClipEntryDetail; timer: number } | null = null;

// ---------- 元素获取 ----------

function el<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`界面缺少必要的元素：#${id}`);
  }
  return element as T;
}

const listEl = el<HTMLElement>('list');
const statusEl = el<HTMLSpanElement>('status-text');
const countEl = el<HTMLSpanElement>('status-count');
const searchEl = el<HTMLInputElement>('search-input');
const pausedBanner = el<HTMLDivElement>('paused-banner');
const settingsPanel = el<HTMLDivElement>('settings-panel');
const confirmDialog = el<HTMLDivElement>('confirm-dialog');
const toastEl = el<HTMLDivElement>('toast');

// ---------- 提示与状态 ----------

function showToast(message: string, kind: 'ok' | 'warn' = 'ok'): void {
  toastEl.textContent = message;
  toastEl.className = `toast toast--${kind}`;
  toastEl.hidden = false;
  window.setTimeout(() => {
    toastEl.hidden = true;
  }, 1600);
}

function setStatus(text: string, kind: 'ok' | 'fail' | 'pending' = 'ok'): void {
  statusEl.textContent = text;
  statusEl.className = `status status--${kind === 'ok' ? 'ok' : kind === 'fail' ? 'fail' : 'pending'}`;
}

/**
 * 统一处理 IPC 信封：失败时把原因显示给用户，并返回 null 让调用方短路。
 * 不静默吞掉错误（见 docs/编码规范.md §5）。
 */
function unwrap<T>(envelope: { ok: true; data: T } | { ok: false; error: string }, what: string): T | null {
  if (envelope.ok) {
    return envelope.data;
  }
  setStatus(`${what}失败：${envelope.error}`, 'fail');
  showToast(envelope.error, 'warn');
  return null;
}

// ---------- 时间与展示格式化 ----------

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 日期分组标题：今天 / 昨天 / 具体日期 */
function formatDayLabel(timestamp: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(timestamp);
  const dayMs = 24 * 60 * 60 * 1000;

  if (day === today) return '今天';
  if (day === today - dayMs) return '昨天';
  const date = new Date(timestamp);
  return `${String(date.getMonth() + 1)} 月 ${String(date.getDate())} 日`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- 卡片渲染 ----------

function createActionButton(label: string, title: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `card__action ${extraClass}`.trim();
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function renderCard(entry: ClipEntryMeta): HTMLElement {
  const card = document.createElement('article');
  card.className = 'card';
  if (entry.pinned) {
    card.classList.add('card--pinned');
  }
  card.dataset.id = entry.id;

  // 缩略图：图片条目显示占位图 + 真实尺寸信息
  const thumb = document.createElement('div');
  thumb.className = 'card__thumb';
  if (entry.kind === 'image' && entry.image !== undefined) {
    const img = document.createElement('img');
    img.className = 'card__thumb-img';
    img.alt = '图片条目';
    img.src = './assets/placeholder-thumb.png';
    thumb.appendChild(img);
  } else {
    thumb.textContent = '文';
    thumb.classList.add('card__thumb--text');
  }

  const body = document.createElement('div');
  body.className = 'card__body';

  const meta = document.createElement('div');
  meta.className = 'card__meta';
  const time = document.createElement('span');
  time.className = 'card__time';
  time.textContent = formatTime(entry.updatedAt);
  meta.appendChild(time);

  if (entry.kind === 'image' && entry.image !== undefined) {
    const sub = document.createElement('span');
    sub.className = 'card__sub';
    sub.textContent = `${String(entry.image.width)} × ${String(entry.image.height)} · ${formatBytes(entry.image.sizeBytes)}`;
    meta.appendChild(sub);
  }
  if (entry.truncated === true) {
    const warn = document.createElement('span');
    warn.className = 'card__sub card__sub--warn';
    warn.textContent = '内容过长，已截断';
    meta.appendChild(warn);
  }
  body.appendChild(meta);

  if (entry.kind === 'text') {
    const preview = document.createElement('p');
    preview.className = 'card__preview';
    // 用 textContent 而非 innerHTML：剪贴板内容是不可信输入
    preview.textContent = entry.textPreview ?? '（无预览）';
    body.appendChild(preview);
  }

  const actions = document.createElement('div');
  actions.className = 'card__actions';

  const primaryLabel = currentSettings?.pasteMode === 'copyOnly' ? '复制' : '粘贴';
  const primaryTitle =
    currentSettings?.pasteMode === 'copyOnly'
      ? '复制到剪贴板（当前设置：仅复制）'
      : '复制并粘贴到当前窗口';

  actions.appendChild(
    createActionButton(primaryLabel, primaryTitle, () => {
      void runPrimaryAction(entry);
    }, 'card__action--primary'),
  );
  actions.appendChild(
    createActionButton('复制', '仅复制到剪贴板，不切换窗口', () => {
      void runCopy(entry);
    }),
  );
  actions.appendChild(
    createActionButton(
      entry.pinned ? '取消置顶' : '置顶',
      entry.pinned ? '取消置顶' : '置顶（永久保留，不参与自动清理）',
      () => {
        void runTogglePinned(entry);
      },
    ),
  );
  actions.appendChild(
    createActionButton('删除', '删除这条记录', () => {
      void runDelete(entry);
    }, 'card__action--danger'),
  );

  body.appendChild(actions);
  card.appendChild(thumb);
  card.appendChild(body);
  return card;
}

function renderEmptyState(message: string, hint: string): void {
  const empty = document.createElement('section');
  empty.className = 'empty';

  const icon = document.createElement('div');
  icon.className = 'empty__icon';
  icon.textContent = '📋';

  const title = document.createElement('p');
  title.className = 'empty__title';
  title.textContent = message;

  const hintEl = document.createElement('p');
  hintEl.className = 'empty__hint';
  hintEl.textContent = hint;

  empty.appendChild(icon);
  empty.appendChild(title);
  empty.appendChild(hintEl);
  listEl.appendChild(empty);
}

/** 按日期分组渲染整个列表 */
function renderList(): void {
  listEl.replaceChildren();

  if (currentEntries.length === 0) {
    const hasFilter = currentQuery !== '' || currentFilter !== 'all';
    renderEmptyState(
      hasFilter ? '没有找到匹配的记录' : '还没有记录，复制点东西试试',
      hasFilter ? '试试换个关键词，或把筛选切回「全部」。' : '应用在后台持续运行，你复制的文字和图片会自动出现在这里。',
    );
    countEl.textContent = '';
    return;
  }

  let lastDayLabel = '';
  for (const entry of currentEntries) {
    const dayLabel = formatDayLabel(entry.updatedAt);
    if (dayLabel !== lastDayLabel) {
      const group = document.createElement('h2');
      group.className = 'group__title';
      group.textContent = dayLabel;
      listEl.appendChild(group);
      lastDayLabel = dayLabel;
    }
    listEl.appendChild(renderCard(entry));
  }

  countEl.textContent = `共 ${String(currentEntries.length)} 条`;
}

// ---------- 数据加载 ----------

async function reload(): Promise<void> {
  setStatus('正在加载…', 'pending');

  const envelope = await api().listEntries({ query: currentQuery, kind: currentFilter });
  const entries = unwrap(envelope, '加载列表');
  if (entries === null) {
    return;
  }

  currentEntries = entries;
  renderList();
  setStatus('已就绪', 'ok');
}

async function reloadSettings(): Promise<void> {
  const envelope = await api().getSettings();
  const settings = unwrap(envelope, '读取设置');
  if (settings === null) {
    return;
  }
  currentSettings = settings;

  pausedBanner.hidden = !settings.paused;

  for (const preset of document.querySelectorAll<HTMLButtonElement>('.preset[data-days]')) {
    preset.classList.toggle('is-active', Number(preset.dataset.days) === settings.retentionDays);
  }
  for (const preset of document.querySelectorAll<HTMLButtonElement>('.preset[data-mode]')) {
    preset.classList.toggle('is-active', preset.dataset.mode === settings.pasteMode);
  }
  el<HTMLInputElement>('custom-days-input').value = String(settings.retentionDays);
  el<HTMLDivElement>('retention-current').textContent = `当前：保留 ${String(settings.retentionDays)} 天`;

  const diagnostics = unwrap(await api().diagnostics(), '读取诊断信息');
  if (diagnostics !== null) {
    el<HTMLDivElement>('data-root').textContent = diagnostics.dataRoot;
    el<HTMLDivElement>('diagnostics-line').textContent =
      `条目 ${String(diagnostics.entries)}（文字 ${String(diagnostics.text)} / 图片 ${String(diagnostics.image)}）` +
      `· 置顶 ${String(diagnostics.pinned)}` +
      `· 采集${diagnostics.watcherRunning ? '运行中' : '已停止'}` +
      (diagnostics.damagedLines > 0 ? `· 跳过损坏行 ${String(diagnostics.damagedLines)}` : '');
  }

  // 主按钮文案随粘贴模式变化，故需重绘列表
  renderList();
}

// ---------- 各操作 ----------

async function runCopy(entry: ClipEntryMeta): Promise<void> {
  const result = unwrap(await api().copyEntry({ id: entry.id }), '复制');
  if (result === null) {
    return;
  }
  if (!result.ok) {
    showToast(result.error ?? '复制失败', 'warn');
    return;
  }
  showToast('已复制到剪贴板');
}

async function runPrimaryAction(entry: ClipEntryMeta): Promise<void> {
  const result = unwrap(await api().pasteEntry({ id: entry.id }), '粘贴');
  if (result === null) {
    return;
  }
  if (!result.ok) {
    showToast(result.error ?? '粘贴失败', 'warn');
    return;
  }
  if (result.autoPasted) {
    showToast('已粘贴到当前窗口');
    return;
  }
  // 部分成功必须如实说明下一步，不假装已经粘贴（见 设计规范 §8）
  showToast(result.notice ?? '已复制到剪贴板，请按 Ctrl+V');
}

async function runTogglePinned(entry: ClipEntryMeta): Promise<void> {
  const updated = unwrap(await api().setPinned({ id: entry.id, pinned: !entry.pinned }), '置顶');
  if (updated === null) {
    return;
  }
  showToast(updated.pinned ? '已置顶，不会被自动清理' : '已取消置顶');
  await reload();
}

async function runDelete(entry: ClipEntryMeta): Promise<void> {
  const detail = unwrap(await api().getEntry({ id: entry.id }), '读取详情');
  if (detail === null) {
    return;
  }

  const removed = unwrap(await api().deleteEntry({ id: entry.id }), '删除');
  if (removed === null) {
    return;
  }

  // 记住被删内容以便撤销
  if (pendingUndo !== null) {
    window.clearTimeout(pendingUndo.timer);
  }
  const timer = window.setTimeout(() => {
    pendingUndo = null;
  }, 5000);
  pendingUndo = { entry: detail, timer };

  showToast('已删除，5 秒内可点这里撤销', 'ok');
  toastEl.classList.add('toast--clickable');
  await reload();

  // 撤销入口：点击提示条
  const undo = (): void => {
    void runUndo();
  };
  toastEl.onclick = undo;
}

async function runUndo(): Promise<void> {
  if (pendingUndo === null) {
    return;
  }
  const { entry, timer } = pendingUndo;
  window.clearTimeout(timer);
  pendingUndo = null;
  toastEl.onclick = null;
  toastEl.classList.remove('toast--clickable');

  const restored = unwrap(await api().restoreEntry({ entry }), '撤销删除');
  if (restored === null) {
    return;
  }
  showToast('已撤销删除');
  await reload();
}

async function applyRetentionDays(days: number): Promise<void> {
  const updated = unwrap(await api().updateSettings({ retentionDays: days }), '保存期限');
  if (updated === null) {
    return;
  }
  showToast(`保存期限已设为 ${String(updated.retentionDays)} 天`);
  await reload();
  await reloadSettings();
}

async function applyPasteMode(mode: 'auto' | 'copyOnly'): Promise<void> {
  const updated = unwrap(await api().updateSettings({ pasteMode: mode }), '粘贴方式');
  if (updated === null) {
    return;
  }
  showToast(mode === 'copyOnly' ? '主按钮已改为「仅复制」' : '主按钮已改为「复制并粘贴」');
  await reloadSettings();
}

async function setPaused(paused: boolean): Promise<void> {
  const updated = unwrap(await api().updateSettings({ paused }), '暂停状态');
  if (updated === null) {
    return;
  }
  pausedBanner.hidden = !updated.paused;
  showToast(updated.paused ? '已暂停记录' : '已恢复记录');
}

async function performClear(): Promise<void> {
  confirmDialog.hidden = true;
  const result = unwrap(await api().clearEntries(), '清空历史');
  if (result === null) {
    return;
  }
  showToast(`已清空 ${String(result.removed)} 条（置顶已保留）`);
  await reload();
}

// ---------- 事件装配 ----------

function setupSearch(): void {
  let debounce: number | null = null;
  searchEl.addEventListener('input', () => {
    if (debounce !== null) {
      window.clearTimeout(debounce);
    }
    // 即时过滤：短延时可避免每个字符都打一次 IPC
    debounce = window.setTimeout(() => {
      currentQuery = searchEl.value;
      void reload();
    }, 120);
  });
}

function setupSegments(): void {
  const segments = Array.from(document.querySelectorAll<HTMLButtonElement>('.segment'));
  for (const segment of segments) {
    segment.addEventListener('click', () => {
      const filter = segment.dataset.filter;
      if (filter !== 'all' && filter !== 'text' && filter !== 'image') {
        return;
      }
      currentFilter = filter;
      for (const other of segments) {
        const isTarget = other === segment;
        other.classList.toggle('is-active', isTarget);
        other.setAttribute('aria-pressed', String(isTarget));
      }
      void reload();
    });
  }
}

function setupSettingsPanel(): void {
  const open = (): void => {
    settingsPanel.hidden = false;
    void reloadSettings();
  };
  const close = (): void => {
    settingsPanel.hidden = true;
  };

  el<HTMLButtonElement>('settings-button').addEventListener('click', open);
  el<HTMLButtonElement>('settings-close').addEventListener('click', close);

  for (const preset of document.querySelectorAll<HTMLButtonElement>('.preset[data-days]')) {
    preset.addEventListener('click', () => {
      void applyRetentionDays(Number(preset.dataset.days));
    });
  }
  for (const preset of document.querySelectorAll<HTMLButtonElement>('.preset[data-mode]')) {
    preset.addEventListener('click', () => {
      const mode = preset.dataset.mode;
      if (mode === 'auto' || mode === 'copyOnly') {
        void applyPasteMode(mode);
      }
    });
  }

  el<HTMLButtonElement>('apply-days-button').addEventListener('click', () => {
    const input = el<HTMLInputElement>('custom-days-input');
    const days = Number(input.value);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      showToast('请输入 1 到 365 之间的整数天数', 'warn');
      return;
    }
    void applyRetentionDays(days);
  });

  el<HTMLButtonElement>('clear-button').addEventListener('click', () => {
    confirmDialog.hidden = false;
  });
  el<HTMLButtonElement>('confirm-cancel').addEventListener('click', () => {
    confirmDialog.hidden = true;
  });
  el<HTMLButtonElement>('confirm-ok').addEventListener('click', () => {
    void performClear();
  });

  el<HTMLButtonElement>('resume-button').addEventListener('click', () => {
    void setPaused(false);
  });
  el<HTMLButtonElement>('refresh-button').addEventListener('click', () => {
    void reload();
  });
}

function setupKeyboard(): void {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!confirmDialog.hidden) {
        confirmDialog.hidden = true;
        return;
      }
      if (!settingsPanel.hidden) {
        settingsPanel.hidden = true;
        return;
      }
      // 关闭窗口 → 主进程会隐藏到托盘（见 docs/设计规范.md §7）
      window.close();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchEl.focus();
      searchEl.select();
    }
  });
}

function setupSubscriptions(): void {
  api().onEntriesChanged(() => {
    void reload();
  });
  api().onWatcherState((state) => {
    if (state.paused !== undefined) {
      pausedBanner.hidden = !state.paused;
      if (currentSettings !== null) {
        currentSettings.paused = state.paused;
      }
    }
    if (state.openSettings === true) {
      settingsPanel.hidden = false;
      void reloadSettings();
    }
  });
}

async function bootstrap(): Promise<void> {
  setupSearch();
  setupSegments();
  setupSettingsPanel();
  setupKeyboard();
  setupSubscriptions();

  await reloadSettings();
  await reload();

  const health = unwrap(await api().ping(), '自检');
  if (health !== null) {
    setStatus(health.message, 'ok');
  }
}

void bootstrap();
