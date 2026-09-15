# 会话记录 · 打包与交付（Phase 7）

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-15 |
| 阶段 | Phase 7 · 打包与交付 |
| 状态 | ✅ 完成（产物的人工复验待做） |
| 涉及标准文件 | \`docs/技术方案.md\`、\`docs/构建与运行.md\` |

---

## 1. 本阶段目标

产出可交付的 Windows 运行包，并留下用户向文档。**动手前先验证 electron-builder 是否可用**（计划中标注的风险项）。

## 2. 完成事项

- [x] **可行性验证（P7-00）** —— 走 Node API 直接调用 \`electron-builder\`，绕开命令行派生这一层
- [x] **免安装包组装脚本（P7-01）** —— \`scripts/build-portable.mjs\`，复用 \`node_modules/electron/dist\`
- [x] **\`README.md\`（P7-02）** —— 功能、使用、已知限制、从源码构建
- [x] **产物验收（P7-03）** —— 用打包后的 exe 自身跑冒烟自检
- [x] **\`npm run dist\` 改为可用命令** —— 原命令依赖 electron-builder，在本机必然失败

## 3. 验证结果

| 检查项 | 命令 / 方式 | 结果 | 备注 |
|---|---|---|---|
| 类型检查（四项） | \`tsc -p tsconfig{node,preload,renderer-build,test}.json\` | ✅ 全部退出码 0 | |
| 单元测试 | \`node test/run-tests.mjs\` | ✅ 153/153 | |
| 组装脚本 | \`node scripts/build-portable.mjs\` | ✅ 退出码 0，产物 367.6 MB | |
| **打包产物自检** | 运行 \`release/ClipHistory-win-x64/ClipHistory.exe\`（设 \`CLIPHISTORY_SMOKE_TEST=1\`） | ✅ **62/62 断言通过**，退出码 0 | 证明产物真的能跑，且托盘图标从 \`resources/assets\` 正确加载 |
| 产物的人工复验 | — | ⚠️ 待用户确认 | 需在干净位置双击运行确认观感 |

## 4. 问题与解决

| # | 问题 | 现象 | 处理 | 结论 |
|---|---|---|---|---|
| 1 | **electron-builder 需要联网下载 Electron 发行版** | 打包走到 \`packaging\` 阶段后失败：\`connect ETIMEDOUT 20.205.243.166:443\` | 实测确认 \`github.com\` 不可达、且没有缓存的发行版 zip；改为**复用 \`node_modules/electron/dist\`** 手工组装免安装目录 | ✅ 已解决；记入 **C-19**。**重要澄清**：失败原因是网络，**不是**沙箱的进程派生限制 |
| 2 | 组装脚本写成了 TypeScript 语法 | \`.mjs\` 里写了 \`export interface\` 与参数类型注解，Node 直接报 \`Unexpected token 'export'\` | 去掉全部类型注解（\`.mjs\` 是纯 JS）。**这是低级失误**，本应先自查 | ✅ 已修正 |
| 3 | 目录体积统计函数写成了半成品 | \`directorySize\` 里有个空洞的循环，目录永远返回 0 | 改为正确递归 | ✅ 已修正 |
| 4 | 打包资源路径约定 | \`main.ts\` 在 \`app.isPackaged\` 时读 \`process.resourcesPath/assets\` | 组装脚本同时放 \`resources/assets\`（图标）与 \`resources/app\`（应用代码），并删除 \`default_app.asar\` | ✅ 已解决；记入 **C-20** |

## 5. 对标准文件的改动

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| \`docs/技术方案.md\` | 技术选型表的打包方式改为「手工组装免安装目录」；新增 **C-19**（本机无法用 electron-builder 出包及原因）、**C-20**（打包资源路径约定）；目录结构补入 \`build-portable.mjs\` | 这是对已批准方案的**又一次实质变更**（原计划明确写的是 electron-builder 出 NSIS + portable），必须留痕并说明代价 |
| \`docs/构建与运行.md\` | §2.3 更新 electron-builder 实测结论；§7 重写为手工组装流程；新增 **§7.1「为什么没有 NSIS 安装包」** 及代价表、将来恢复安装包的路径 | 原文档写的是「Phase 7 才验证」，现已验证完毕，必须更新为结论 |
| \`README.md\` | 新建 | 面向用户的交付文档（P7-02） |
| \`package.json\` | \`dist\` 脚本改为 build + 组装 | 原命令在本机必然失败，留着会误导 |

## 6. 下一阶段入口

- **项目状态**：Phase 0–7 **全部完成**。153 个单元测试 + 62 项集成断言全绿。
- **剩余事项**（均需人工验收，见 \`devlog/待办事项.md\`）：
  1. \`P3-06\` 截图采集的真实表现（**从用户截图看其实已经正常** —— 曾出现 \`399 × 334 · 76 KB\` 的图片卡片）
  2. \`P4-09\` / \`P5-05\` 界面与自动粘贴的人工确认
  3. \`P6-05\` 设计规范的观感核对
  4. \`P7-04\` 免安装包的人工复验
- **可选的后续增强**：全局快捷键、开机自启、导出/备份、边缘吸附、exe 图标写入、多设备同步。
