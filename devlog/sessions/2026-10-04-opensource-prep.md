# 会话记录 · 开源准备与隐私核查（非阶段任务）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-04 |
| 阶段 | 非阶段任务 · 开源前的隐私核查与仓库规范化 |
| 状态 | ✅ 完成（规范项已落地并**已发布到 GitHub**；两项需用户决策的历史/披露问题按用户决定「维持现状」） |
| 涉及标准文件 | `CLAUDE.md`（工作目录行 + 修订记录）；`README.md`（数字与 Node 版本） |

---

## 1. 本阶段目标

产品功能已完成（Phase 0–7），下一步是把仓库开源到 GitHub。开源是**不可逆**动作：
提交历史一旦推送，其中的作者邮箱、路径、开发过程记录都无法真正撤回。因此本任务的目标是
在推送前**穷尽式地核对隐私暴露面**，并把「缺了就不像正经开源项目」的基础设施补齐。

## 2. 完成事项

- [x] **全仓库隐私扫描**（源码 + 文档 + devlog + 图标 + **完整 git 历史**）—— 验证：正则扫描 `@qq.com|api_key|secret|password|token|PRIVATE KEY|ghp_|sk-` 及手机号/身份证/银行卡形态，逐条人工复核命中项
- [x] **git 历史体积与内容核查** —— 验证：`git rev-list --objects --all` 统计最大 blob 为 `package-lock.json`（137KB），无数据目录文件、无 `release/` 产物、无 `.exe`/`.zip`；`.git` 目录仅 0.7MB
- [x] **确认「已删除但仍留在历史里」的文件** —— 验证：`git log --all --diff-filter=D --name-only` 仅命中 `scripts/_probe-builder.cjs`，导出其历史版本逐行检查，只含 `appId`，无密钥
- [x] **新增 `LICENSE`（MIT）** —— 验证：文件存在，与 `package.json` 的 `"license": "MIT"` 一致，GitHub 可识别
- [x] **`package.json` 移除 `"private": true`** —— 验证：读回该字段已不存在；同时补 `engines.node >= 24`、`author`、`keywords`
- [x] **新增 `.gitattributes`** —— 验证：`* text=auto eol=lf` 已固定行尾，落实 [待办事项](../待办事项.md) P0-07；二进制类型显式标注为 `binary`
- [x] **新增 `.github/`**：CI + Issue 表单 + PR 模板 —— 验证：`ci.yml` 在 `windows-latest` 上跑 `npm ci` → `typecheck` → `test`
- [x] **核实 CI 确实能通过（不写假绿灯）** —— 验证：本机实跑 `node test/run-tests.mjs` → `pass 166 / fail 0`；`npm run typecheck` → 退出码 0
- [x] **核实单测不依赖 Electron** —— 验证：`grep "from 'electron'" test/` 零命中，因此在无 GUI 的 CI runner 上也能跑
- [x] **修正 README 过期信息** —— 验证：单测数字 153 → **166**、自检断言 62 → **64**（均以实跑结果为准）；Node 要求 `≥ 20` → **`≥ 24`**
- [x] **修正 `CLAUDE.md` 硬编码的本机绝对路径** —— 验证：该行为 `C:\Users\Direction\Desktop\历史粘贴`，既是**用户名泄露**又是**错误路径**（实际在 `Desktop\AI\` 下），已改为「仓库根目录」表述

## 3. 验证结果

| 检查项 | 命令 / 方式 | 结果 | 备注 |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ | 退出码 0，四个 tsconfig 全过 |
| 单元测试 | `node test/run-tests.mjs` | ✅ | `tests 166 / pass 166 / fail 0`（39 套件，2.04s） |
| 密钥与凭据扫描 | 全库正则 | ✅ | **零命中** |
| 真实剪贴板内容入库 | 全库正则（手机号/证件号/银行卡形态） | ✅ | **零命中**，测试夹具均为合成数据 |
| 构建产物入库 | `git ls-files` + 全历史 `--name-only` | ✅ | `release/`（367.7MB）、`dist/`、`node_modules/` 从未入过库 |
| 图标版权风险 | 目视 + 溯源 | ✅ | `assets/icon.png` 为 `scripts/generate-icons.mjs` 生成的通用剪贴板图标 |
| 行尾警告 | `.gitattributes` | ✅ | 已修（P0-07 完成） |

**失败项说明**：无失败项。但存在**两项已识别、按用户决定维持现状**的隐私暴露，见 §4。

## 4. 问题与解决

| 问题 | 现象 | 处理 | 结论 |
|---|---|---|---|
| **提交身份含真实 QQ 邮箱** | 全部 22 个提交的 author 与 committer 均为 `Direction <1125249874@qq.com>`；改 `git config` 只影响未来提交，历史元数据不变 | 已向用户说明三条路（重写历史改 noreply 邮箱 / 放弃历史重开库 / 维持现状）及其不可逆性 | ⚠️ **用户决定维持现状**（「无所谓，就用现有邮箱」）。该决定已确认，风险为用户已知 |
| **邮箱明文出现在文档中** | `devlog/待办事项.md` 2 处、`devlog/sessions/2026-09-15-phase0-foundation.md` 3 处 | 同上，属同一决定范围 | ⚠️ 同上，未改动 |
| **开发过程披露（AI 协作与沙箱）** | `docs/` 与 `devlog/` 大量出现 DSH / DeepSeek / 沙箱 / `~/.dsh/settings.yaml` | 询问用户是否公开、是否改写为中性表述 | ✅ **用户决定全部公开、不做处理** |
| `appId` 含用户 handle | `package.json` 的 `"appId": "com.direction.cliphistory"` | 仅提示可改中性域名 | ⚠️ **未改**（属产品标识，改动会影响已分发产物的升级路径，需用户单独拍板，见 P8-04） |
| README 数字与事实不符 | 声称 153 单测 / 62 断言，实际 166 / 64 | 以实跑结果更正 | ✅ 已修正 |
| README 的 Node 版本要求错误 | 声称 `≥ 20`，但 `test/run-tests.mjs` 依赖 `node:module` 的 `registerHooks`（需 Node ≥ 24），照 README 装 Node 20 会直接跑不了测试 | 改为 `≥ 24`，并同步 `CLAUDE.md` 与 `engines` | ✅ 已修正。**这是会直接劝退贡献者的错误** |
| Issue 模板中的仓库地址 | `config.yml` 需要绝对 URL | 用 `OWNER/REPO` 占位 | ✅ 已替换为 `Direction12/ClipHistory`，见 P8-01 |
| **首次推送被 GitHub 拒绝** | `refusing to allow an OAuth App to create or update workflow '.github/workflows/ci.yml' without 'workflow' scope` | 执行 `gh auth refresh -h github.com -s workflow` 补 scope 后重推成功 | ✅ 已解决。**OAuth App token 推送 `.github/workflows/` 必须显式带 `workflow` scope**；其余 22 个提交不含 workflow，故已先推上去 |
| 本机 curl 访问 GitHub 报 exit 35 | `schannel: ... CRYPT_E_NO_REVOCATION_CHECK`（加 `--ssl-no-revoke` 即通） | 查明本机用 **Steam++（Watt Toolkit）** 加速 GitHub：hosts 把 30 余个 GitHub 域名指向 `127.0.0.1`，由 `Steam++.Accelerator` 在本机 443 端口反代 | ✅ 已定位。curl 需 `--ssl-no-revoke`；git 默认不检查吊销故不受影响。**注意 hosts 被改写属该工具的正常行为** |

## 5. 对标准文件的改动

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `LICENSE`（新增） | MIT 全文，版权方 `Direction`（2026） | `package.json` 已声明 MIT 却无正文，开源必备 |
| `.gitattributes`（新增） | `* text=auto eol=lf` + 二进制类型标注 | 消除 Windows/Linux 行尾差异造成的整文件 diff；落实 P0-07 |
| `.github/workflows/ci.yml`（新增） | `windows-latest` 上跑 typecheck + test | 让「全绿」可被外部验证，而非仅凭自述 |
| `.github/ISSUE_TEMPLATE/*`、`pull_request_template.md`（新增） | Bug/功能表单、PR 自检清单 | 引导贡献者先查已知限制；PR 清单固化了 §5 开发护栏中与安全相关的四条 |
| `package.json` | 去 `private`；加 `engines.node >= 24`、`author`、`keywords` | 开源必需；`engines` 让版本要求可被执行 |
| `README.md` | 修正 166/64 与 Node ≥ 24；新增 CI 徽章占位、参与贡献、许可三节 | 原数字与版本要求均与事实不符 |
| `CLAUDE.md` | 工作目录去绝对路径；技术栈补 Node 版本；追加修订记录 | 避免硬编码本机路径（护栏要求）；版本要求需与 README 一致 |

## 6. 下一阶段入口

- **成果**：仓库已发布到 <https://github.com/Direction12/ClipHistory>（**公开**），**23 个提交全部推送**，GitHub 已识别 MIT 许可，CI 自动触发（`.github/workflows/ci.yml`）。
- **发布过程（可复现要点）**：
  1. 本机 GitHub 通路依赖 Steam++：hosts 被指向 `127.0.0.1`，curl 必须加 `--ssl-no-revoke`；
  2. 用 gh CLI 设备码登录（`gh auth login --web`，token 存 **keyring**，非明文文件）；
  3. **必须补 `workflow` scope**（`gh auth refresh -s workflow`），否则含 `.github/workflows/` 的提交会被 GitHub 拒绝；
  4. 凭据助手用 `credential.https://github.com.helper` 配成**仓库局部**，避免改动全局 git 配置（已核实 `git config --global --list` 为空）。
- **推送后须确认**：`git status --ignored --short` 只应出现 `dist/`、`node_modules/`、`release/`；**不要**用 `git add -f` 加入被忽略路径（`release/` 有 367.7MB，会撞 GitHub 100MB 上限并永久留在历史里）。
- **剩余可选优化（不阻塞开源，待用户决定）**：
  1. **P8-02**：README 补 1 张界面截图 + 1 个自动粘贴 GIF（目前**一张图都没有**）。
  2. **P8-03**：把 `docs/构建与运行.md` §2.1–§2.3 的「本机沙箱」内容重构为「通用安装 + 附录：受限环境」。外部贡献者按现有文档操作会困惑——他们的 `npm install` 不会报 EPERM。
  3. **P8-04**：`appId` 是否改为中性域名。
