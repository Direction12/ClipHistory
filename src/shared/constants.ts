/**
 * 跨进程共用常量。
 *
 * 纪律：数值必须与 docs/存储与数据格式规范.md 一致；IPC 通道必须与 docs/技术方案.md §5 一致。
 * 新增通道时，两处都要更新（见 devlog/待办事项.md 的一致性检查）。
 */

/** 索引与设置文件格式版本 */
export const DATA_FORMAT_VERSION = 1;

/** 默认存储期限（天），见 docs/存储与数据格式规范.md §2 */
export const DEFAULT_RETENTION_DAYS = 3;

/** 存储期限可选预设（天） */
export const RETENTION_PRESETS = [1, 3, 5] as const;

/** 存储期限合法范围（天） */
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 365;

/** 默认去重窗口（ms）：同内容在此窗口内只算一次动作 */
export const DEFAULT_DEDUP_WINDOW_MS = 5000;

/** 去重窗口合法范围（ms） */
export const DEDUP_WINDOW_MIN_MS = 0;
export const DEDUP_WINDOW_MAX_MS = 60000;

/** 剪贴板轮询间隔（ms）。Windows 无可靠原生变更事件，只能轮询（见 CLAUDE.md §6 LIM-02） */
export const CLIPBOARD_POLL_INTERVAL_MS = 800;

/** 单条文本存储上限（字符）。超出则截断并标记 */
export const MAX_TEXT_LENGTH = 100_000;

/** 列表预览保留的字符数 */
export const TEXT_PREVIEW_LENGTH = 120;

/** 条目总数上限，超出时优先收缩最旧的未置顶条目 */
export const MAX_ENTRIES = 10_000;

/** 索引压缩阈值：总行数超过该值且冗余明显时执行压缩 */
export const INDEX_COMPACT_THRESHOLD = 2000;

/** 过期清理的执行间隔（ms）：6 小时 */
export const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 删除后可撤销的时间窗口（ms），见 docs/设计规范.md §7 */
export const UNDO_WINDOW_MS = 5000;

/** 默认窗口尺寸，见 docs/设计规范.md §4 */
export const DEFAULT_WINDOW_BOUNDS = {
  x: undefined as number | undefined,
  y: undefined as number | undefined,
  width: 420,
  height: 640,
} as const;

/** 窗口最小尺寸 */
export const MIN_WINDOW_WIDTH = 360;
export const MIN_WINDOW_HEIGHT = 480;

/** 窗口透明度合法范围与默认值（见 docs/需求规格说明书.md FR-13b） */
export const OPACITY_MIN = 0.4;
export const OPACITY_MAX = 1;
export const DEFAULT_OPACITY = 1;

/** 数据目录环境变量覆盖键：用于开发期隔离测试数据（见 docs/构建与运行.md §5） */
export const DATA_DIR_ENV_KEY = 'CLIPHISTORY_DATA_DIR';

/** 开发模式环境变量键：设置后主进程加载 Vite dev server 而非本地文件 */
export const DEV_SERVER_ENV_KEY = 'CLIPHISTORY_DEV_SERVER';

/** 应用标识 */
export const APP_ID = 'com.direction.cliphistory';

/**
 * IPC 通道名（渲染层 → 主进程，invoke/返回）。
 * 对应 docs/技术方案.md §5.1。
 */
export const IPC_INVOKE = {
  entriesList: 'entries:list',
  entriesGet: 'entries:get',
  entriesSetPinned: 'entries:setPinned',
  entriesDelete: 'entries:delete',
  entriesRestore: 'entries:restore',
  entriesClear: 'entries:clear',
  pasteCopy: 'paste:copy',
  pasteToActive: 'paste:toActive',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  /** 诊断计数与运行状态；不含任何剪贴板内容。供冒烟自检与故障排查使用 */
  appDiagnostics: 'app:diagnostics',
  /** 骨架期连通性自检；保留用于「主进程是否活着」的快速判定 */
  appPing: 'app:ping',
} as const;

/**
 * IPC 通道名（主进程 → 渲染层，send/推送）。
 * 对应 docs/技术方案.md §5.2。
 */
export const IPC_EVENT = {
  entriesChanged: 'entries:changed',
  watcherState: 'watcher:state',
} as const;

/** 渲染层挂载点全局名 */
export const RENDERER_API_KEY = 'clipHistory';

/** 命中「尚未实现」的通道时统一使用的错误文案前缀 */
export const NOT_IMPLEMENTED_PREFIX = '该功能将在后续版本提供';
