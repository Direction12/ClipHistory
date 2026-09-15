/**
 * 托盘图标与菜单。
 *
 * 唯一真源：docs/需求规格说明书.md FR-07（托盘常驻、关窗不退出）。
 *
 * 菜单项：打开历史粘贴 / 暂停记录（勾选） / 清空历史（保留置顶） / 设置 / 退出。
 * 「退出」是唯一能真正结束进程的入口 —— 关窗口只隐藏到托盘。
 */

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';

export interface TrayCallbacks {
  readonly showWindow: () => void;
  readonly togglePause: (paused: boolean) => void;
  readonly clearHistory: () => void;
  readonly openSettings: () => void;
  readonly quit: () => void;
}

export interface TrayHandle {
  readonly tray: Tray;
  /** 更新「暂停记录」勾选状态与图标提示 */
  setPaused(paused: boolean): void;
  setTooltip(text: string): void;
  destroy(): void;
}

/** 托盘图标路径；与应用图标共用同一张 PNG（Windows 托盘会自动缩放） */
function resolveTrayIconPath(assetsDir: string): string {
  return join(assetsDir, 'icon.png');
}

/**
 * 创建托盘。
 *
 * 图标缺失时**不抛异常**：宁可没有托盘也不能让应用起不来，
 * 由调用方记录日志后继续。
 */
export function createTray(
  assetsDir: string,
  isPaused: () => boolean,
  callbacks: TrayCallbacks,
): TrayHandle | null {
  const iconPath = resolveTrayIconPath(assetsDir);
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    return null;
  }

  const tray = new Tray(image);
  let paused = isPaused();

  const rebuild = (): void => {
    const template: MenuItemConstructorOptions[] = [
      {
        label: '打开历史粘贴',
        click: () => {
          callbacks.showWindow();
        },
      },
      { type: 'separator' },
      {
        label: '暂停记录',
        type: 'checkbox',
        checked: paused,
        click: (menuItem) => {
          paused = menuItem.checked;
          callbacks.togglePause(paused);
          rebuild();
          updateVisual();
        },
      },
      { type: 'separator' },
      {
        label: '清空历史（保留置顶）',
        click: () => {
          callbacks.clearHistory();
        },
      },
      {
        label: '设置',
        click: () => {
          callbacks.openSettings();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          callbacks.quit();
        },
      },
    ];

    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  const updateVisual = (): void => {
    // 暂停时用提示文字与标题说明状态；图标本身不变形，避免用户误以为程序坏了
    tray.setToolTip(paused ? '历史粘贴（记录已暂停）' : '历史粘贴（正在记录）');
  };

  rebuild();
  updateVisual();

  // 单击托盘图标即唤起窗口（Windows 上的常见预期）
  tray.on('click', () => {
    callbacks.showWindow();
  });

  return {
    tray,
    setPaused: (value: boolean) => {
      paused = value;
      rebuild();
      updateVisual();
    },
    setTooltip: (text: string) => {
      tray.setToolTip(text);
    },
    destroy: () => {
      tray.destroy();
    },
  };
}
