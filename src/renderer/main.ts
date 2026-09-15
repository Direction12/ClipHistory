/**
 * 渲染层入口（Phase 1 骨架）。
 *
 * 本阶段只做两件事：
 * 1. 装配顶栏的筛选分段与设置按钮的交互状态；
 * 2. 经 window.clipHistory 调用一次「主进程连通性自检」，把结果显示在状态栏。
 *
 * 纪律：不直接访问文件系统、不直接操作剪贴板（见 docs/技术方案.md §3）。
 */

import type { EntryFilter } from '../shared/types';

/** 取状态栏元素；缺失即视为界面装配错误，直接抛出让问题显形 */
function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`界面缺少必要的元素：#${id}`);
  }
  return element as T;
}

/** 装配类型筛选分段：同一时刻只有一项处于选中态 */
function setupSegments(): void {
  const segments = Array.from(document.querySelectorAll<HTMLButtonElement>('.segment'));

  const activate = (target: HTMLButtonElement, filter: EntryFilter): void => {
    for (const segment of segments) {
      const isTarget = segment === target;
      segment.classList.toggle('is-active', isTarget);
      segment.setAttribute('aria-pressed', String(isTarget));
    }
    // Phase 4 接入真实数据后，这里会触发一次按 filter 的列表查询
    document.body.dataset.filter = filter;
  };

  for (const segment of segments) {
    segment.addEventListener('click', () => {
      const filter = segment.dataset.filter;
      if (filter === 'all' || filter === 'text' || filter === 'image') {
        activate(segment, filter);
      }
    });
  }
}

/** 调用主进程自检并把结果写进状态栏 */
async function checkBridge(): Promise<void> {
  const status = requireElement<HTMLSpanElement>('bridge-status');

  status.className = 'status status--pending';
  status.textContent = '正在检测通信通路…';

  try {
    const result = await window.clipHistory.ping();
    if (result.ok) {
      status.className = 'status status--ok';
      status.textContent = `通信正常 · ${result.message}`;
    } else {
      status.className = 'status status--fail';
      status.textContent = `通信异常：${result.message}`;
    }
  } catch (error) {
    // 失败必须说清原因，不静默吞掉（见 docs/编码规范.md §5）
    const reason = error instanceof Error ? error.message : String(error);
    status.className = 'status status--fail';
    status.textContent = `无法连接主进程：${reason}`;
  }
}

function setupSettingsButton(): void {
  const button = requireElement<HTMLButtonElement>('settings-button');
  button.addEventListener('click', () => {
    // 设置面板在 Phase 4 实现
    const status = requireElement<HTMLSpanElement>('bridge-status');
    status.className = 'status status--pending';
    status.textContent = '设置面板将在 Phase 4 提供';
  });
}

function bootstrap(): void {
  setupSegments();
  setupSettingsButton();
  requireElement<HTMLButtonElement>('ping-button').addEventListener('click', () => {
    void checkBridge();
  });
  void checkBridge();
}

bootstrap();
