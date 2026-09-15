/**
 * 一次性可行性验证：electron-builder 能否在本机完成最小编译（--dir，不生成安装包）。
 * 用 Node API 而不是 npx，避开「命令行派生」这一层问题。
 * 探测完即删除。
 */
const path = require('node:path');

async function main() {
  const builder = require('electron-builder');
  console.log('[验证] electron-builder 版本:', require('electron-builder/package.json').version);
  console.log('[验证] 开始最小打包（dir 模式，不生成安装包）…');

  try {
    const result = await builder.build({
      targets: builder.Platform.WINDOWS.createTarget('dir', builder.Arch.x64),
      config: {
        appId: 'com.direction.cliphistory',
        productName: 'ClipHistory',
        directories: { output: 'release-probe' },
        // 最小集合：只打包产物与必要文件
        files: ['dist/**/*', 'assets/**/*', 'package.json'],
        win: { target: 'dir' },
        // 明确指定 Electron 分发来源：优先用 node_modules 里已下载的版本
        electronVersion: require('electron/package.json').version,
      },
    });

    console.log('[验证] 打包完成，产物:', JSON.stringify(result));
  } catch (error) {
    console.log('[验证] 打包失败:', String(error && error.message ? error.message : error));
    if (error && error.stack) {
      console.log('[验证] 堆栈前 800 字:', String(error.stack).slice(0, 800));
    }
  }
}

void main();
