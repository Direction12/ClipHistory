/**
 * 测试入口：在**单个进程内**依次加载所有测试文件。
 *
 * 为什么不用 `node --test`（见 docs/构建与运行.md §2.4）：
 * 1. `node --test` 默认给每个测试文件派生一个子进程做隔离，本机沙箱禁止派生（`EPERM: spawn`）；
 * 2. 即便加 `--experimental-test-isolation=none`，其内部运行上下文也不应用通过
 *    `--import` 注册的解析钩子，导致 `.ts` 导入无法解析；
 * 3. 本仓库源码使用无扩展名导入（为让 tsc 能编译成 CommonJS），而 ESM 要求显式扩展名。
 *
 * 因此：用 `node:module` 的 `registerHooks`（同步钩子 API，Node ≥ 24）在本进程内
 * 注册解析钩子，把无扩展名 / `.js` 后缀的导入映射到磁盘上真实的 `.ts` 文件，
 * 然后依次 `import()` 各测试文件。`node:test` 被直接 import 时会自动执行其中的
 * test() 注册并在进程结束时汇总输出，失败用例会使进程以非零码退出。
 *
 * 为什么不用异步的 `resolve` 导出（`--loader` / `--import` 那种写法）：
 * 实测在本机 Node 24 下该钩子不会被调用，模块解析仍走默认逻辑而失败。
 *
 * 用法：node test/run-tests.mjs
 */

import { registerHooks } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 依次尝试的候选后缀 */
const CANDIDATE_SUFFIXES = ['.ts', '.mts', '.js', '.mjs', '/index.ts'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 只处理相对导入；node: 内置模块与包名交给默认解析
    if (specifier.startsWith('.') && context.parentURL !== undefined) {
      let basePath;
      try {
        basePath = fileURLToPath(new URL(specifier, context.parentURL));
      } catch {
        return nextResolve(specifier, context);
      }

      // 原样命中磁盘文件：交给默认逻辑（保留其 format 判定）
      if (existsSync(basePath)) {
        return nextResolve(specifier, context);
      }

      // 补后缀；源码若写了 `.js` 而磁盘上是 `.ts`，先去掉后缀再试
      const withoutScriptExtension = basePath.replace(/\.(js|mjs|cjs)$/, '');
      for (const base of [basePath, withoutScriptExtension]) {
        for (const suffix of CANDIDATE_SUFFIXES) {
          const candidate = `${base}${suffix}`;
          if (existsSync(candidate)) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true };
          }
        }
      }
    }

    return nextResolve(specifier, context);
  },
});

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

const testFiles = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.ts'))
  .sort();

if (testFiles.length === 0) {
  console.error('未找到任何测试文件（test/*.test.ts）');
  process.exit(1);
}

console.log(`运行 ${String(testFiles.length)} 个测试文件：${testFiles.join('、')}`);

for (const fileName of testFiles) {
  await import(pathToFileURL(join(TEST_DIR, fileName)).href);
}
