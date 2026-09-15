/**
 * Windows 原生剪贴板模块单元测试。
 *
 * 为什么需要单独测：图片写回与模拟按键都必须借 PowerShell 完成（Electron 44 无法做到，
 * 见 docs/技术方案.md C-05），因此「命令怎么拼、失败怎么报」必须被固定住。
 * 这里用注入的假 runner，不真的启动 PowerShell。
 *
 * 运行方式：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sendPasteKeys, writePngToClipboard, type CommandResult, type CommandRunner } from '../src/main/native-clipboard';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

interface Recorder {
  readonly calls: Array<{ file: string; args: readonly string[] }>;
  readonly runner: CommandRunner;
}

function createRecorder(result: CommandResult): Recorder {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  return {
    calls,
    runner: async (file, args) => {
      calls.push({ file, args });
      return result;
    },
  };
}

/**
 * 取出本次调用实际执行的 PowerShell 脚本明文。
 *
 * 为什么不能直接断言命令行参数：脚本是用 `-EncodedCommand`（UTF-16LE + base64）传递的
 * —— 这是为了避开命令行编码/引号问题（见 docs/技术方案.md C-15）。
 * 所以这里先解码再断言，反而能更严格地验证脚本内容。
 */
function decodeScript(recorder: Recorder, index = 0): string {
  const call = recorder.calls[index];
  assert.ok(call !== undefined, '应已调用一次外部命令');
  const encodedIndex = call.args.indexOf('-EncodedCommand');
  assert.ok(encodedIndex >= 0, '必须用 -EncodedCommand 传递脚本，避免编码/引号被破坏');
  const encoded = call.args[encodedIndex + 1] ?? '';
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

const OK: CommandResult = { ok: true, stdout: 'OK', stderr: '' };

describe('原生剪贴板 — 写图片', () => {
  test('调用 powershell.exe 并带上 STA 与 SetImage', async () => {
    const recorder = createRecorder(OK);

    const result = await writePngToClipboard(TINY_PNG, { run: recorder.runner });

    assert.equal(result.ok, true);
    assert.equal(recorder.calls.length, 1);
    const call = recorder.calls[0]!;
    assert.equal(call.file, 'powershell.exe');
    assert.ok(call.args.includes('-STA'), 'Windows.Forms 剪贴板访问必须用 STA 线程模式');
    assert.ok(call.args.includes('-NoProfile'), '应避免受用户 profile 影响');

    const script = decodeScript(recorder);
    assert.match(script, /System\.Windows\.Forms/);
    assert.match(script, /System\.Drawing/);
    assert.match(script, /Clipboard\]::SetImage/);
    assert.match(script, /FromFile/);
  });

  test('失败时把 PowerShell 的错误信息透传给用户', async () => {
    const recorder = createRecorder({
      ok: false,
      stdout: '',
      stderr: 'Exception calling "SetImage"',
      stderrDetail: undefined,
    } as CommandResult);

    const result = await writePngToClipboard(TINY_PNG, { run: recorder.runner });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /SetImage/);
  });

  test('PowerShell 未能启动时区分「没启动」与「退出码非 0」', async () => {
    const recorder = createRecorder({ ok: false, stdout: '', stderr: '', spawnError: 'ENOENT' });

    const result = await writePngToClipboard(TINY_PNG, { run: recorder.runner });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /无法启动 PowerShell/);
    assert.match(result.error ?? '', /ENOENT/);
  });

  test('退出码非 0 但无任何输出时也给出可读原因', async () => {
    const recorder = createRecorder({ ok: false, stdout: '', stderr: '' });

    const result = await writePngToClipboard(TINY_PNG, { run: recorder.runner });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /退出码非 0/);
  });
});

describe('原生剪贴板 — 发送粘贴按键', () => {
  test('调用 SendKeys 发送 Ctrl+V', async () => {
    const recorder = createRecorder(OK);

    const result = await sendPasteKeys({ run: recorder.runner });

    assert.equal(result.ok, true);
    const script = decodeScript(recorder);
    assert.match(script, /SendKeys/);
    assert.match(script, /\^v/);
    assert.ok(recorder.calls[0]!.args.includes('-STA'));
  });

  test('失败时返回原因，不假装发送成功', async () => {
    const recorder = createRecorder({ ok: false, stdout: '', stderr: '拒绝访问', spawnError: undefined } as CommandResult);

    const result = await sendPasteKeys({ run: recorder.runner });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /拒绝访问/);
  });

  test('PowerShell 未能启动时如实说明', async () => {
    const recorder = createRecorder({ ok: false, stdout: '', stderr: '', spawnError: 'EPERM' });

    const result = await sendPasteKeys({ run: recorder.runner });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /无法启动 PowerShell/);
  });
});
