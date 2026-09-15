# 会话记录 · 最小可运行骨架（Phase 1）

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-15 |
| 阶段 | Phase 1 · 最小可运行骨架 |
| 状态 | ✅ 完成 |
| 涉及标准文件 | `docs/技术方案.md`、`docs/构建与运行.md`、`CLAUDE.md` |

---

## 1. 本阶段目标

在规范体系（Phase 0）之上，搭出**能真正启动的最小骨架**：依赖安装、构建链路、主进程窗口、preload 白名单通路、渲染层占位页与淡粉色设计令牌。目标不是功能，而是「一条能跑通的通路」，为 Phase 2 起的功能开发提供稳定底座。

## 2. 完成事项

- [x] **依赖安装** —— 验证：`npm install` 成功，299 个包，0 漏洞；`package.json` 记录 `electron@44.3.0`、`typescript@7.0.2`、`electron-builder@26.15.3`、`@types/node@26.5.1`
- [x] **Electron 二进制就位** —— 验证：`node_modules/electron/dist/electron.exe` 存在
- [x] **多目标 tsconfig 体系** —— 验证：`tsconfig.base.json`（公共选项）+ `tsconfig.node.json`（主进程，CommonJS）+ `tsconfig.preload.json`（preload 临时产物）+ `tsconfig.renderer-build.json`（渲染层，ESM）；三者 `tsc -p` 均退出码 0
- [x] **共享契约文件** —— 验证：`src/shared/types.ts`（`EntryKind`/`PasteMode`/`ClipEntryMeta`/`ClipEntryDetail`/`Settings`/`OperationResult`/`ClipHistoryApi` 等）与 `src/shared/constants.ts`（期限、去重窗口、轮询间隔、上限、12 个 IPC 通道）与 `docs/技术方案.md` §5 及 `docs/存储与数据格式规范.md` 一致
- [x] **主进程最小窗口** —— 验证：`src/main/main.ts` 创建 420×640 窗口，安全配置 `contextIsolation:true` / `nodeIntegration:false` / `sandbox:true`；含单实例锁、`ready-to-show` 再显示、外链交系统浏览器
- [x] **preload 白名单骨架** —— 验证：仅暴露 `appVersion` 与 `ping()`，不暴露 `ipcRenderer` 原始对象
- [x] **渲染层占位页** —— 验证：`index.html`（含 CSP 限制为 `'self'`、`connect-src 'none'`）+ `main.ts`（分段筛选交互 + 状态栏显示 IPC 通路自检）+ `styles.css`（`docs/设计规范.md` §2 全部设计令牌）+ `global.d.ts`
- [x] **图标生成** —— 验证：`npm run gen:icons` 生成 `assets/icon.png`（1414 字节）与 `assets/icon.ico`（1436 字节）；纯 Node 手写 PNG/ICO 编码器，零第三方依赖
- [x] **构建编排脚本** —— 验证：`node scripts/build-all.mjs` 退出码 0，产出 `dist/main`、`dist/preload/preload.js`、`dist/renderer/renderer/*`
- [x] **冒烟自检机制** —— 验证：`npm run smoke`（`--smoke`）输出「冒烟自检通过：窗口已加载，且 preload 已注入 IPC 通路」，退出码 0

## 3. 验证结果

| 检查项 | 命令 / 方式 | 结果 | 备注 |
|---|---|---|---|
| 类型检查（主进程） | `tsc -p tsconfig.node.json` | ✅ 退出码 0 | |
| 类型检查（preload） | `tsc -p tsconfig.preload.json` | ✅ 退出码 0 | |
| 类型检查（渲染层） | `tsc -p tsconfig.renderer-build.json` | ✅ 退出码 0 | |
| 完整构建 | `node scripts/build-all.mjs` | ✅ 退出码 0 | 产物路径见 `docs/构建与运行.md` §5 |
| 冒烟自检 | `electron .`（`CLIPHISTORY_SMOKE_TEST=1`） | ✅ 退出码 0 | 窗口加载 + preload 通路均通过 |
| 安全配置未被放宽 | 审阅 `src/main/main.ts` | ✅ | `contextIsolation`/`sandbox` 保持文档要求值 |
| 运行时依赖仅 electron | 检查 `package.json` | ✅ | 仅 4 个 devDependencies，无额外运行时依赖 |
| `npm test` | — | N/A | 测试框架 Phase 2 建立 |

**失败项说明**：无。过程中出现 4 个环境级阻塞与 2 个代码缺陷，均已在 §4 定位并修复。

## 4. 问题与解决

| # | 问题 | 现象 | 处理 | 结论 |
|---|---|---|---|---|
| 1 | npm 缓存位于工作区外 | `EPERM ... _cacache\tmp\...` | 用 `--cache` 指向 `%TEMP%` | ✅ 已解决，记入构建规范 §2.1 |
| 2 | postinstall 需派生进程 | `EPERM: spawn`（`arborist/rebuild.js`） | 加 `--ignore-scripts`，再手动跑 Electron 的 `install.js` | ✅ 已解决 |
| 3 | Electron 缓存目录在工作区外 | `EPERM mkdir ...\AppData\Local\electron` | 用 `electron_config_cache`（**非** `ELECTRON_CACHE`）重定向 | ✅ 已解决 |
| 4 | **Vite 完全无法工作** | `npx vite build` → `EPERM: spawn`（rolldown/esbuild 原生工具链） | **弃用 Vite**，渲染层改由 tsc 编译；自写 `copy-static.mjs` 搬运静态资源、`build-preload.mjs` 打包 preload | ✅ 已解决，属**技术方案变更**，已回写文档 |
| 5 | **Electron 在默认沙箱下崩溃** | 退出码 `0x7003`，仅报 `crashpad ... not connected`，无任何 JS 日志；**最小探针同样崩溃** | 证明与项目代码无关，是沙箱阻断 Chromium 的进程模型；放宽到 `danger-full-access` 后正常 | ⚠️ 环境限制，记入构建规范 §2.3；日常开发需在可运行 Chromium 的环境执行 |
| 6 | TypeScript 7 移除旧选项 | `TS5108: Option 'moduleResolution=node10' has been removed` | 删除 `moduleResolution` 配置项（CommonJS 下默认即可） | ✅ 已解决 |
| 7 | 渲染层路径不匹配 | 冒烟报 `-6 ERR_FILE_NOT_FOUND` | 产物实际在 `dist/renderer/renderer/index.html`，修正主进程加载路径 | ✅ 已解决，记入 `docs/技术方案.md` C-02 |
| 8 | preload 无法加载共享常量 | `Unable to load preload script` + `module not found: ../shared/constants` | 证实 **sandbox preload 不能 require 相对模块**（C-01）；改为构建时打包自包含单文件并内联常量 | ✅ 已解决，记入 `docs/技术方案.md` C-01 |
| 9 | 内联后仍报 `constants_1 is not defined` | tsc 把导入编译为 `constants_1.X` 别名引用 | 内联时同步剥离别名前缀，并加「产物不得残留相对 require」的构建期断言 | ✅ 已解决 |

**未解决的问题**：electron-builder 能否在本机打包**尚未验证**（见待办 P7-01）。

## 5. 对标准文件的改动

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `docs/技术方案.md` | 技术选型表：构建方式由 Vite 改为 tsc + 自写脚本；新增 §2.1 实际依赖清单；目录结构更新为真实结构；新增 §2.2 平台约束 C-01/C-02；关键决策新增 D-10~D-12；修订记录追加一行 | 技术方案发生实质变更（弃用 Vite），且实测得出两条必须遵守的平台约束，不回写会让后续阶段踩同一个坑 |
| `docs/构建与运行.md` | 重写：新增 §2.1 受限环境安装三步、§2.2 弃用 Vite 的原因与替代、§2.2.1 preload 自包含约束、§2.3 Electron 与打包的运行限制、§4 冒烟自检、§5 真实产物路径、§7 图标重复打包的提醒、§8 TS 7 注意事项、§9 排查表新增 6 行；修订记录追加一行 | 原文档写的 `npm install` 与 `vite build` 在本机**都会失败**，属「文档与事实不符」，必须修正，否则下一阶段会重复踩坑 |
| `CLAUDE.md` | 当前阶段更新为 Phase 1 完成；修订记录追加一行 | 规则入口需反映真实进度 |

## 6. 下一阶段入口

- **下一步从哪开始**：Phase 2 —— 存储层。建议顺序：`src/main/settings.ts`（逐字段校验 + 原子写入）→ `src/main/store.ts`（NDJSON 折叠读 / 追加 / 压缩 / 增删改查 / 图片落地）→ 测试框架 `test/`（`node:test`）→ 覆盖 T-01~T-04、T-15、T-16。
- **Phase 2 前置条件**：
  1. 需先确认 `npm test` 的运行方式：`node:test` 是否需要额外 loader 才能直接跑 TS（Node 24 原生支持类型擦除，但需实测）；若不行，则用 tsc 编译测试后再跑，**不引入测试框架依赖**。
  2. 数据目录覆盖开关 `CLIPHISTORY_DATA_DIR`（`P2-03`）要早做，否则测试会污染真实历史目录。
- **需要用户确认的问题**：
  1. **本机沙箱对开发的影响**（重要）：Electron 在当前工作模式下**无法启动窗口**（Chromium 需要的能力被沙箱阻断）。选项：① 你在自己的终端里运行 `npm run dev` 验收界面（推荐，最简单）；② 每次需要我验证界面时，你允许我用放宽权限运行；③ 我先只做能用单元测试验证的部分（Phase 2/3），界面相关的 Phase 4/6 等你验收。**请告知你倾向哪种**。
  2. 是否确认进入 Phase 2。
