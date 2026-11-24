<img src="assets/word.png" alt="Orcai" height="38">

# Orcai

**Orca 侧栏里的 OMP 工作台。** 规划由只读模型完成，执行由默认模型接手；Orca 里正在工作的 OMP 会话集中显示在一块面板里；写完代码后可以自动跑独立验收。

An Orca sidebar workbench for OMP: plan/execute model routing, live agent sessions, and out-of-session acceptance review.

- **Orzic**：规划/执行路由、验收设置、OMP 会话列表
- **便签**：运行时的临时记录，复制后手动粘贴到 OMP

## 功能

### 规划 → 执行路由

- 新任务先切换 `modelRoles.plan` 只读规划；规划成功后写 `PLAN.md`。
- 只有 `PLAN.md` 写入成功且内容非空，才在同一会话切回 `modelRoles.default` 执行。
- 规划阶段阻断 `bash` / `eval` / `task`；写工具只允许 `PLAN.md`。
- 规划模型不可用时中止本轮，不静默换模型。
- 子代理默认不参与主会话路由；可选用 `task.prewalk`。

### 可编辑的切换规则

在面板「路由 → 切换规则」里编辑，保存后下一轮生效。首次打开或旧版全空配置会自动填入常用规则，可点「填入常用规则」恢复：

- **回到规划**：`重新规划`、`重新计划`、`重新评估`、`审查一下`、`评估一下`、`分析一下`、`复盘一下`、`拆解一下`、`先做计划`、`先写计划`、`先给方案`、`换个方案`、`换一个方案`、`换个思路`、`不要直接执行`、`不要开始执行`、`不要开始实现`、`不要继续执行`、`不要执行`、`先别执行`
- **继续执行**：`开始实现`、`开始执行`、`继续实现`、`继续执行`、`按计划执行`、`按计划实现`、`执行计划`、`接着做`、`动手吧`、`开干`、`开工`、`开始做`、`继续推进`、`直接实现`、`直接执行`、`start implementing`、`implement it`、`go ahead`、`proceed`、`continue`
- **PLAN.md 必含内容**：默认留空，不强制固定标题；需要时再填，例如 `## 步骤`、`## 验证`

规则按纯文本包含匹配，不区分大小写；回到规划的规则优先。新任务仍然先规划，`PLAN.md` 写入成功、内容非空和模型可用性是不可绕过的门禁。

### 实时 OMP 会话

- 通过 Orca 的 agent 状态读取真实 `working` / `blocked` / `waiting` / `done`，按 session id 对应本地 JSONL；订阅 `agent.status.changed` 即时更新。
- 活跃会话置顶，同组按最近活动时间排序。
- 排序是活跃优先的实时排序：宿主状态或最近活动时间变化时，行会移动到新位置。该排序是后续用户明确要求，覆盖早期“固定位置”原型，不是回归。
- 显示最近 20 分钟有活动的会话；仍在 `working` 的会话即使超过 20 分钟也继续显示。
- 每条只显示名称、当前模型、阶段、最近工具和项目，用分隔线隔开。

### 可编辑切换规则

Orzic 路由卡里的「切换规则」默认收起，展开后可以填写：

- **保留内置识别**：继续、执行、重新规划等默认短语是否仍然有效。
- **回到规划的短语**：会话在执行阶段包含这些词时，切回规划模型。
- **继续执行的短语**：已经完成 `PLAN.md` 交接的会话，包含这些词时继续用执行模型。
- **PLAN.md 必含内容**：每行一条，全部包含才允许交接；不满足就留在规划阶段。

每行一条纯文本，包含即匹配、不区分大小写。规划和继续规则同时命中时，规划优先；空列表表示不添加自定义短语。新任务、成功且非空的 `PLAN.md`、模型可用性这些门禁不可绕过。规则保存到插件配置，并从下一轮消息开始生效。

### 验收

- **手动验收**：面板「运行验收」使用 OMP 池模型，或启用已安装的 `ocr` 后走外部评审。
- **自动验收**：执行轮结束后由 `orzic-driver.mjs` 在会话外评审 `HEAD` 提交差异；`REWORK` 可回喂，`PASS` 收口。
- verdict 只有 `pass` / `rework` / `unreviewed` / `failed` / `no-repo`，**只有显式 pass 才算通过**。
- 评审输入可包含 `rule.json`、确定性 `checkCmd` 门禁和本会话已批准的 `PLAN.md`。

### 便签

新建、编辑、删除并持久保存。点击「复制」只写入剪贴板，不会自动注入或发送。

## 安装

要求 **Orca >= 1.4.268** 和可用的 OMP CLI。

### Orca 插件目录

在 Orca 的 **Settings → Plugins → Add marketplace** 添加社区目录：

```text
https://github.com/stablyai/orca-community-plugins.git   ref: main
```

目录收录后搜索 **Orcai** 安装。也可以直接从 Git 仓库安装：

```text
https://github.com/esseener/orcai.git
```

首次启用会请求以下权限：

| 权限 | 用途 |
|---|---|
| `storage:own` | 保存设置、便签和验收配置 |
| `agent:read` | 读取 Orca 中 OMP 会话的真实工作状态和状态事件 |
| `workspace:read` | 找到会话所属工作区，再查询其中的 agent 状态 |

插件不会发送终端输入、写工作区文件，也不会上传遥测。

### 本地开发

```powershell
npm ci
orca plugin dev load . --json
orca plugin dev reload . --json
orca plugin open esseener.orcai --panel orzic --json
```

### 从旧开发版升级

- 公开插件身份是 `esseener.orcai`；旧的本地开发条目 `local.orzic` 需要 `orca plugin dev unload` 后重新加载，不会自动迁移。
- 面板 id 保持 `orzic`，所以 `--panel orzic` 的脚本无需修改；插件 key 从 `local.orzic` 变为 `esseener.orcai`（开发目录和 Git 安装同 key）。
- 设置和便签属于插件存储，不跨身份迁移；升级前请先复制需要的便签。

## 开发

```powershell
npm run typecheck
npm test              # orca plugin test .：node --test + 面板交互
npm run smoke:omp     # 可选：隔离目录启动 OMP，验证扩展加载与规划/执行路由
npm run check:version
```

主要文件：

| 文件 | 职责 |
|---|---|
| `src/worker.ts` | 配置读写、模型目录、会话列表、验收 handler |
| `src/panel.tsx` | Orca 侧栏面板（Orzic + 便签） |
| `src/orzic-loop.ts` | OMP 扩展：规划只读、`PLAN.md` 交接、执行阶段 |
| `src/orzic-driver.mjs` | 会话外验收 driver：锁、session pin、评审、返工注入 |
| `src/acceptance.ts` | 手动验收与 verdict 落盘 |
| `src/orzic-session-state.mjs` | 会话 ID、可见性、事件状态合并与排序 |

## 边界

- 自动验收评审的是已提交的 `HEAD` 差异；只改工作树、尚未提交的改动可能评审不到。
- 会话列表依赖 OMP 的 JSONL 格式；OMP 大版本升级后请先运行 `npm test` 与 `npm run smoke:omp`。
- 同一 cwd 下若有多个 OMP 会话，返工注入只认构建 driver 时传入的 session 文件，不会猜测。
- 验收与路由是工作流约束，不是操作系统级沙箱；各 CLI 自身的权限保护仍然生效。

## 版本

当前版本 **0.2.4**。变更见 [CHANGELOG.md](CHANGELOG.md)；实现与验证记录见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。
