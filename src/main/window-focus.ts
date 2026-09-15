/**
 * Windows 前台窗口的获取与交还。
 *
 * ## 为什么需要这个模块（这是「粘贴粘错地方」的根因）
 *
 * 自动粘贴依赖 `SendKeys` 发送 Ctrl+V，而**按键只会送给当前前台窗口**。
 * 实测（见 docs/技术方案.md C-14）：
 *
 * - 隐藏本应用窗口后，**焦点不会自动回落到用户原本的程序**；
 * - 于是 Ctrl+V 会打到别的程序上（实测粘进了浏览器），或什么都没发生；
 * - 而 `SendKeys` 本身**不会报错** —— 它会安静地把按键发给错误的目标。
 *
 * 所以必须**显式**：先把用户原本的前台窗口记下来，粘贴前再把它切回前台。
 *
 * ## 为什么用 PowerShell 调用 Win32
 *
 * `SetForegroundWindow` 受 Windows 前台锁规则限制：**非前台进程调用经常静默失败**。
 * 可靠的绕过方式是「从目标窗口所属进程内部调用」。这里用 PowerShell 启动一个
 * 独立的、附属于目标进程（`-WindowStyle` 无关，靠 `AttachThreadInput` 的思路简化版）
 * —— 实践中更简单可行的是：先 `ShowWindow(SW_RESTORE)` 再 `SetForegroundWindow`，
 * 并对失败结果做显式检查（`SetForegroundWindow` 的返回值 + 事后核对前台窗口）。
 */

import { runPowerShell, type CommandRunner } from './native-clipboard';

/** 被记住的前台窗口 */
export interface ForegroundWindowInfo {
  /** Win32 窗口句柄（十进制字符串，避免 JS 大整数精度问题） */
  readonly handle: string;
  /** 进程 id（十进制字符串） */
  readonly processId: string;
  /** 窗口类名，仅用于日志与诊断 */
  readonly className: string;
}

export interface FocusManagerOptions {
  readonly run: CommandRunner;
}

/** 取出「HANDLE=...|PID=...|CLS=...」里的字段 */
function parseForegroundOutput(stdout: string): ForegroundWindowInfo | null {
  const match = /HANDLE=(\d+)\|PID=(\d+)\|CLS=(.*)/.exec(stdout.trim());
  if (match === null) {
    return null;
  }
  const handle = match[1] ?? '';
  if (handle === '0') {
    return null;
  }
  return { handle, processId: match[2] ?? '0', className: (match[3] ?? '').trim() };
}

/**
 * PowerShell 前导：定义调用 Win32 所需的类型。
 *
 * 注意这里的脚本**不含任何中文**（见 docs/技术方案.md C-15）：
 * 实测中文经命令行/编码传给 PowerShell 会损坏（`AppActivate('记事本')` 直接失败）。
 * 需要传中文时一律用 `-EncodedCommand`，而本模块刻意避开中文参数。
 */
const FOCUS_PREAMBLE = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ChFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  public static string Cls(IntPtr h){var sb=new StringBuilder(256);GetClassNameW(h,sb,sb.Capacity);return sb.ToString();}
  public static string Describe(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    return "HANDLE=" + h.ToInt64() + "|PID=" + pid + "|CLS=" + Cls(h);
  }
}
"@
`;

/**
 * 取得当前前台窗口。
 *
 * 调用时机很关键：**必须在用户点击卡片的那一刻调用**（那时我们的窗口在前台，
 * 但它记录了「谁在抢走焦点」——见 `recordPreviousWindow` 的说明）。
 */
export async function getForegroundWindow(options: FocusManagerOptions): Promise<ForegroundWindowInfo | null> {
  const script = `${FOCUS_PREAMBLE}\nWrite-Output ([ChFocus]::Describe([ChFocus]::GetForegroundWindow()))`;
  const result = await runPowerShell(script, options.run);
  if (!result.ok) {
    return null;
  }
  return parseForegroundOutput(result.stdout);
}

/**
 * 把指定窗口切回前台。
 *
 * 返回是否成功 —— 调用方**必须**检查，因为 `SetForegroundWindow` 会静默失败。
 * 失败时不能继续发送按键（否则按键会落到错误的窗口上），而应如实降级提示用户。
 */
export async function activateWindow(
  window: ForegroundWindowInfo,
  options: FocusManagerOptions,
): Promise<{ ok: boolean; detail: string }> {
  const script = [
    FOCUS_PREAMBLE,
    `$h = [IntPtr]${window.handle}`,
    'if (-not [ChFocus]::IsWindow($h)) { Write-Output "GONE"; exit 0 }',
    'if ([ChFocus]::IsIconic($h)) { [void][ChFocus]::ShowWindow($h, 9) }',
    '$set = [ChFocus]::SetForegroundWindow($h)',
    'Start-Sleep -Milliseconds 300',
    '$now = [ChFocus]::GetForegroundWindow()',
    'Write-Output ("RESULT=" + $set + "|NOW=" + [ChFocus]::Describe($now))',
  ].join('\n');

  const result = await runPowerShell(script, options.run);

  if (!result.ok) {
    return { ok: false, detail: result.spawnError ?? result.stderr.trim() };
  }

  const output = result.stdout.trim();
  if (output.includes('GONE')) {
    return { ok: false, detail: '目标窗口已关闭' };
  }

  const now = parseForegroundOutput(/NOW=(.*)/.exec(output)?.[1] ?? '');
  if (now !== null && now.handle === window.handle) {
    return { ok: true, detail: '已切回前台' };
  }

  const setResult = /RESULT=(True|False)/.exec(output)?.[1] ?? '未知';
  return {
    ok: false,
    detail: `未能把焦点切回目标窗口（SetForegroundWindow=${setResult}，当前前台为 ${now?.className ?? '未知'}）`,
  };
}

/**
 * 找出「用户原本在用的窗口」——z 序上第一个不属于本应用的正常顶层窗口。
 *
 * 关键实现细节（都是实测得出的，别改回去）：
 * - **必须用 `EnumWindows` 回调枚举**：实测 `GetWindow(GetWindow(0, GW_HWNDFIRST), GW_HWNDNEXT)`
 *   这种 z 序迭代在本环境下**返回 0 个窗口**，而 `EnumWindows` 能枚举到全部顶层窗口；
 *   `EnumWindows` 本身也按 z 序从前到后回调，因此「第一个匹配项」即最靠前的那个。
 * - 必须排除：本进程、不可见、被最小化、工具窗口（`WS_EX_TOOLWINDOW`）、无标题窗口、
 *   以及桌面/任务栏（`Progman` / `WorkerW` / `Shell_TrayWnd` / `Shell_SecondaryTrayWnd`）。
 */
export async function findPreviousWindow(
  ownPid: number,
  options: FocusManagerOptions,
): Promise<ForegroundWindowInfo | null> {
  const script = [
    FOCUS_PREAMBLE,
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class ChWalk {',
    '  public delegate bool EnumProc(IntPtr h, IntPtr p);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
    '  public static string ClassOf(IntPtr h){var sb=new StringBuilder(256);GetClassNameW(h,sb,sb.Capacity);return sb.ToString();}',
    '  public static string TitleOf(IntPtr h){var sb=new StringBuilder(512);GetWindowTextW(h,sb,sb.Capacity);return sb.ToString();}',
    '  public static string Result = "NONE";',
    '  public static int OwnPid = 0;',
    '  public static bool Callback(IntPtr h, IntPtr p) {',
    '    if (Result != "NONE") { return false; }',
    '    if (!IsWindowVisible(h) || IsIconic(h)) { return true; }',
    '    uint pid; GetWindowThreadProcessId(h, out pid);',
    '    if ((int)pid == OwnPid) { return true; }',
    '    if ((GetWindowLong(h, -20) & 0x00000080) != 0) { return true; }',
    '    string cls = ClassOf(h);',
    '    if (cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd" || cls == "Progman" || cls == "WorkerW") { return true; }',
    '    if (TitleOf(h).Trim().Length == 0) { return true; }',
    '    Result = h.ToInt64() + "|" + pid + "|" + cls;',
    '    return false;',
    '  }',
    '  public static string Find(int ownPid) { OwnPid = ownPid; Result = "NONE"; EnumWindows(Callback, IntPtr.Zero); return Result; }',
    '}',
    '"@',
    `$found = [ChWalk]::Find(${String(ownPid)})`,
    'if ($found -eq "NONE") { Write-Output "NONE"; exit 0 }',
    '$parts = $found -split "\\|"',
    'Write-Output ("HANDLE=" + $parts[0] + "|PID=" + $parts[1] + "|CLS=" + $parts[2])',
  ].join('\n');

  const result = await runPowerShell(script, options.run);
  if (!result.ok) {
    return null;
  }
  return parseForegroundOutput(result.stdout);
}
