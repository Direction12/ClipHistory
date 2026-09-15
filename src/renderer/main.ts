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

// ---------------------------------------------------------------------------
// 关于本文件为何**不 import 任何模块**（包括 src/shared/constants.ts）：
//
// 渲染层以原生 ESM 直接被浏览器加载，而浏览器的模块解析要求**显式扩展名**且
// **不做目录解析**；tsc 又不会给无扩展名的导入补 `.js`。更麻烦的是相对路径：
// 源码里 `../shared/constants` 是按 `src/renderer/` 算的，编译产物在
// `dist/renderer/renderer/`，同一路径会指向不存在的位置。
//
// 后果是整条模块链加载失败、模块**静默不执行**，界面卡在 HTML 里的初始文字
// 「正在加载…」。这个坑实际发生过（见 devlog/sessions/2026-09-15-phase4-* 与
// 后续修复记录），因此这里刻意让渲染层自包含。
//
// 代价：`RENDERER_API_KEY` 的字面量在本文件与 src/shared/constants.ts 各出现一次。
// 为防两者漂移，集成自检（src/main/smoke.ts）会断言 `window.clipHistory` 确实存在，
// 且断言界面真的完成初始化 —— 一旦挂载名对不上，自检会直接失败。
// ---------------------------------------------------------------------------

/** 与 src/shared/constants.ts 的 RENDERER_API_KEY 保持一致（由集成自检兜底） */
const RENDERER_API_KEY_LITERAL = 'clipHistory';

type ClipFilter = 'all' | 'text' | 'image';

/** 取 preload 注入的 API；名字对不上会拿到 undefined，由自检兜底发现 */
function api(): ClipHistoryBridge {
  return (window as unknown as Record<string, ClipHistoryBridge>)[RENDERER_API_KEY_LITERAL];
}

// ---------- 界面状态 ----------

let currentFilter: ClipFilter = 'all';
let currentQuery = '';
let currentEntries: ClipEntryMeta[] = [];
/** 当前键盘选中的卡片下标；-1 表示未选中（见 docs/设计规范.md §7） */
let selectedIndex = -1;
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
  el<HTMLSpanElement>('toast-text').textContent = message;
  toastEl.className = `toast toast--${kind}`;
  toastEl.hidden = false;
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
    hideToastAction();
  }, 1600);
}

let toastTimer: number | null = null;

/** 在轻提示里显示一个可点动作（目前用于「撤销删除」） */
function showToastAction(label: string, onAction: () => void): void {
  const button = el<HTMLButtonElement>('toast-action');
  button.textContent = label;
  button.hidden = false;
  button.onclick = (event) => {
    event.stopPropagation();
    onAction();
  };
}

function hideToastAction(): void {
  const button = el<HTMLButtonElement>('toast-action');
  button.hidden = true;
  button.onclick = null;
  toastEl.onclick = null;
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
    img.loading = 'lazy';

    const fileName = entry.image.file.replace(/^images[\\/]/, '');
    if (entry.imageAvailable === false) {
      // 文件已丢失：显示占位图，并由下方逻辑标注「图片已丢失」
      img.src = './assets/placeholder-thumb.png';
    } else {
      // 经主进程注册的只读协议读取；渲染层拿不到也不需要文件系统路径
      img.src = `clipimg://${fileName}`;
      img.addEventListener('error', () => {
        img.src = './assets/placeholder-thumb.png';
      });
    }
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

  // 内容文件丢失时必须明确告知，而不是给一个点了没反应的卡片（设计规范 §5）
  const contentMissing =
    (entry.kind === 'text' && entry.textAvailable === false) ||
    (entry.kind === 'image' && entry.imageAvailable === false);
  if (contentMissing) {
    const warn = document.createElement('span');
    warn.className = 'card__sub card__sub--warn';
    warn.textContent = entry.kind === 'image' ? '图片已丢失' : '全文已丢失';
    meta.appendChild(warn);
    card.classList.add('card--broken');
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

  // 卡片固定同时提供「粘贴」与「复制」两个按钮。
  // 不再由设置决定主按钮 —— 「粘贴模式」设置已删除（见需求 CH-01）。
  const pasteButton = createActionButton('粘贴', '复制并粘贴到当前窗口', () => {
    void runPrimaryAction(entry);
  }, 'card__action--primary');
  if (contentMissing) {
    pasteButton.disabled = true;
    pasteButton.title = '内容已丢失，无法粘贴';
  }
  actions.appendChild(pasteButton);

  const copyButton = createActionButton('复制', '仅复制到剪贴板，不切换窗口', () => {
    void runCopy(entry);
  });
  if (contentMissing) {
    copyButton.disabled = true;
    copyButton.title = '内容已丢失，无法复制';
  }
  actions.appendChild(copyButton);
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

/** 更新选中态：只改 class，不重绘列表（重绘会丢失按钮上的点击闭包） */
function applySelection(): void {
  const cards = Array.from(listEl.querySelectorAll<HTMLElement>('.card'));
  cards.forEach((card, index) => {
    const isSelected = index === selectedIndex;
    card.classList.toggle('card--selected', isSelected);
    card.setAttribute('aria-selected', String(isSelected));
    if (isSelected) {
      // 选中项滚入可视区，键盘操作才不至于「选中了却看不到」
      card.scrollIntoView({ block: 'nearest' });
    }
  });
}

function moveSelection(delta: number): void {
  if (currentEntries.length === 0) {
    return;
  }
  const next = selectedIndex + delta;
  if (next < 0 || next >= currentEntries.length) {
    return;
  }
  selectedIndex = next;
  applySelection();
}

/** 取当前选中项；越界返回 null */
function selectedEntry(): ClipEntryMeta | null {
  if (selectedIndex < 0 || selectedIndex >= currentEntries.length) {
    return null;
  }
  return currentEntries[selectedIndex] ?? null;
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
  // 列表变了，选中位置可能已失效：夹到合法范围内
  if (selectedIndex >= currentEntries.length) {
    selectedIndex = currentEntries.length - 1;
  }

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
  applySelection();
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

  pausedBanner.hidden = !settings.paused;

  for (const preset of document.querySelectorAll<HTMLButtonElement>('.preset[data-days]')) {
    preset.classList.toggle('is-active', Number(preset.dataset.days) === settings.retentionDays);
  }
  el<HTMLInputElement>('custom-days-input').value = String(settings.retentionDays);
  el<HTMLInputElement>('always-on-top').checked = settings.alwaysOnTop;
  el<HTMLInputElement>('opacity-input').value = String(Math.round(settings.opacity * 100));
  el<HTMLSpanElement>('opacity-value').textContent = `${String(Math.round(settings.opacity * 100))}%`;
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

  // 撤销入口用明确的按钮，而不是「点提示条本身」——后者用户看不出来能点（设计规范 §10）
  showToast('已删除 1 条', 'ok');
  showToastAction('撤销', () => {
    void runUndo();
  });
  await reload();
}

async function runUndo(): Promise<void> {
  if (pendingUndo === null) {
    return;
  }
  const { entry, timer } = pendingUndo;
  window.clearTimeout(timer);
  pendingUndo = null;
  hideToastAction();

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


async function applyAlwaysOnTop(enabled: boolean): Promise<void> {
  const updated = unwrap(await api().updateSettings({ alwaysOnTop: enabled }), '窗口置顶');
  if (updated === null) {
    return;
  }
  showToast(updated.alwaysOnTop ? '窗口已置顶' : '已取消置顶');
}

async function applyOpacity(percent: number): Promise<void> {
  // 立即在本地回显百分比，避免拖动时数字滞后
  el<HTMLSpanElement>('opacity-value').textContent = `${String(percent)}%`;
  const updated = unwrap(await api().updateSettings({ opacity: percent / 100 }), '窗口透明度');
  if (updated === null) {
    return;
  }
  el<HTMLSpanElement>('opacity-value').textContent = `${String(Math.round(updated.opacity * 100))}%`;
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

  el<HTMLInputElement>('always-on-top').addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement;
    void applyAlwaysOnTop(target.checked);
  });

  const opacityInput = el<HTMLInputElement>('opacity-input');
  // 拖动时只在本地回显，松开才落盘 —— 避免每移动一格就打一次 IPC
  opacityInput.addEventListener('input', () => {
    el<HTMLSpanElement>('opacity-value').textContent = `${opacityInput.value}%`;
  });
  opacityInput.addEventListener('change', () => {
    void applyOpacity(Number(opacityInput.value));
  });

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
      return;
    }

    // 键盘导航只在「焦点不在输入控件」时生效，否则会抢掉输入框的方向键
    const active = document.activeElement;
    const isTyping =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
    if (isTyping) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      // 首次按下时从第一项开始，符合「按一下就选中」的直觉
      if (selectedIndex < 0) {
        selectedIndex = 0;
        applySelection();
        return;
      }
      moveSelection(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (selectedIndex < 0) {
        selectedIndex = 0;
        applySelection();
        return;
      }
      moveSelection(-1);
      return;
    }

    if (event.key === 'Enter') {
      const entry = selectedEntry();
      if (entry !== null) {
        event.preventDefault();
        // Enter 的语义定为「粘贴到当前窗口」：这是历史工具的主动作（见设计规范 §7）
        void runPrimaryAction(entry);
      }
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      const entry = selectedEntry();
      if (entry !== null) {
        event.preventDefault();
        void runCopy(entry);
      }
    }
  });
}

function setupSubscriptions(): void {
  api().onEntriesChanged(() => {
    void reload();
  });
  api().onWatcherState((state) => {
    if (state.openSettings === true) {
      settingsPanel.hidden = false;
    }
    // 主进程在「暂停状态变化」与「设置变更」时都会广播；
    // 这里统一重读设置，避免两处各写一套刷新逻辑而漏掉一半（按钮文案曾因此不更新）。
    void reloadSettings();
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

  // 状态栏最后显示健康串（存储/采集/清理/托盘），它是排查问题时最有用的信息。
  // 界面「已完成初始化」的判定不靠这句文字，而是靠 body 上的就绪标记，
  // 以免文案改动就让自动化验收误判（见 src/main/smoke.ts）。
  const health = unwrap(await api().ping(), '自检');
  if (health !== null) {
    setStatus(health.message, 'ok');
  }

  document.body.dataset.bootState = 'ready';
}

void bootstrap();
