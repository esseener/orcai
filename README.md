<img src="assets/logo5.png" alt="Orzic" height="48">

# Orzic

OMP 的规划/执行侧栏调度器 + 自动验收循环。新请求先交给规划模型只读规划；`PLAN.md` 写入工具成功返回且计划非空后，同一会话切执行模型，之后只有明确继续才留在执行阶段。验收在会话外由独立 judge 对着 diff 和**本会话**已批准的计划判定。

## 面板标签

- **Orzic**：开始任务、规划/执行模型、验收设置和 OMP 会话状态。
- **便签**：记录运行中的临时想法，支持新建、编辑、删除和持久保存。点击「复制」后手动粘贴到 OMP 输入框并自行提交；便签不会自动注入或发送。

## 规划/执行路由

- **规划模型** = `modelRoles.plan`；**执行模型** = `modelRoles.default`
- **新任务先规划**：每条新请求（包括“审查一下 / 做个计划”）都切规划模型；不再按关键词或字数猜成执行
- **执行阶段**：只有本轮成功写入 `PLAN.md` 后才切执行模型；此后只有“继续 / 按计划执行 / 好 / ok”这类**不含新指令**的短句保持执行模型
- **重新规划**：执行阶段出现新的审查、修改或计划要求，回到规划模型
- **规划只读**：`bash` 全阻断，写工具只允许 `PLAN.md`；空计划或写入失败不交接
- **模型不可用**：本轮中止并提示，绝不静默降级到另一个模型
- **子代理同规则** = 内置 task 子代理也启用(`task.prewalk`)
- 会话卡实时显示当前模型、最近工具和模型切换时间线；多会话可切换查看

## 验收(Acceptance)

写完代码的轮次自动跑第三方评审，REWORK 自动回喂返工，PASS 收口。**手动路径**(面板「运行验收」)在 worker 内同步跑；**自动路径**由 `orzic-driver.mjs` 在会话外跑。评审输入包含 git diff、规则，以及 `orzic-plan-<repoKey>.json` 里**已批准的计划**；实现偏离计划会被报成 finding。

### 手动验收 `acceptance.review`

- 默认 `ompJudge`:OMP 池模型按 `rule.json` 规则判定(复用 OMP 认证，无需额外凭证)。
- `ocr` 开启+安装后走外部 `ocr review`(SARIF findings → 确定性 verdict)。
- verdict 只有 `pass`/`rework`/`unreviewed`/`failed`/`no-repo`,**只有显式 `pass` 才算过**;空输出、解析失败、未知 verdict 一律 `failed`。

### 自动验收循环(`orzic-driver.mjs`)

`orzic-loop.ts`(OMP 扩展)在 `agent_end` 检测本轮是否实际执行过受识别的写入工具。结构化 `edit`/`write`/`ast_edit`/`notebook` 需 `isError=false`；`bash`/`eval` 只要实际执行过就算（非零退出也可能已经提交或改文件），最终由 driver 按实际 `HEAD` diff 判定；`PLAN.md` 写入和规划期被阻断的调用不触发。以及 `autoReview` → spawn **detached `orzic-driver.mjs`**。这里记录的是工具调用,不是校验文件是否真的变化;driver 跑在 OMP 进程外：

1. `git diff HEAD~1..HEAD` → `omp --mode json` 评审 → 写 `~/.omp/agent/orzic-review-<key>.json`
2. verdict `rework` + `autoRework` → `omp -r <session>` 注入 findings 返工(≤ `maxRework` 轮)
3. PASS / 无 diff / 到上限 → 写 verdict + `consumed` 标记退出

### 失败安全(fail closed)

- **Session pinning**:`ctx.sessionManager.getSessionFile()` 权威路径经 `ORZIC_SESSION_FILE` 环境变量传给 driver;拿不到 pin → 只评审、**不注入**。永不对「最新同 cwd session」猜测注入。
- **单实例锁(每仓库,目录锁)**:`~/.omp/agent/orzic-driver-<key>.lock` 是**目录**;每个竞争者写独有 `owner-<token>.json`,胜者为「未过期条目里最小 token」——原子、无共享可变文件,`stat→unlink`/`check→mutate` 竞态不存在;心跳只刷自己的 entry,僵尸复活丢锁即退出;不同 repo 各自持锁可并发。`key=basename+SHA256(规范化真实路径) 前16hex`。
- **确定性门禁（省钱,先于评审)**:`checkCmd`(如 `npm run typecheck && npm test`)在 judge 之前跑——挂了直接 `rework` 注入,judge 一次不调;过了才花钱评审。对标 Devin fusion(sidekick 跑 build/test)与 AWS gated review(硬门禁先于 AI 评审)。评审模型保持高配,省 token 靠「免费门禁挡返工 + revision 去重」,不换便宜模型。
- **可选 aislop 质量门禁**：在现有 `typecheck`/测试之后，可用固定版本执行全仓扫描：`npx aislop@0.16.1 ci`。它补充检查 AI 生成代码常见问题，不替代项目已有测试。当前 driver 评审捕获的 `HEAD` 提交差异，不等同于工作树相对 `HEAD` 的变更，因此不要在这里使用裸 `aislop ci --changes` 作为默认命令。
- **Revision 去重（省钱）**：同一 `HEAD` revision+评审模型+规则已评过（`dedupKey` 一致）就直接 `break`,judge 零调用;`omp -r` 后 `HEAD` 没变同处理。
- **双注入防重**:verdict `rework` 注入前写 `consumed:true`;会话内不再发送,回喂只走 driver 的 `omp -r`。
- **停止**:`acceptance.stop({repo})` 读锁内 run token 写 `orzic-stop-<key>`——driver 只认自己铸的 token(不信锁里的 pid,可被杀后复用),协作式本轮结束退出;`{force:true}` 附 `kill:true`,driver 杀自己 spawn 的 `omp -r` 子树(`exitCode/signalCode` 校验防止杀到已释放 pid)再放锁退出。**没有外部进程被 taskkill。**
- **verdict 保真**:无 diff 的空轮次不覆盖上一个 verdict;judge/注入失败的 verdict 永远是 `failed`,绝不 `pass`。

### 面板状态

`acceptance.result({repo})` 轮询该 repo 的 `orzic-review-<key>.json` + lock → 状态条显示 `运行中 · pid:N / 已停 · 第N轮 · verdict · 已回喂`,driver 活着时可点「停止」(协作式,本轮后退出)或「强杀」(driver 自终结+杀 `omp -r` 子树)。

- 「停止」= 协作式(写完当前轮 verdict 后退);「强杀」= driver 立刻杀自己 spawn 的 `omp -r` 子树并退出。Windows `taskkill /T` 沿 ParentProcessId 链杀整棵树(detached 孙进程同死);POSIX 靠 `spawn(detached)` 的子进程组,`kill(-pid)` 全收。
```powershell
npm ci
orca plugin dev load . --json
orca plugin enable local.orzic --approve '<fingerprint>' --json
orca plugin open local.orzic --panel orzic --json
```

## 开发验证

```powershell
npm run typecheck
node --test src/orzic-loop.test.mjs src/orzic-driver.test.mjs src/orzic-verdict.test.mjs src/orzic-models.test.mjs
npm run smoke:omp
```

## 验证记录（本次路由返工）

- `npx tsc -p .` 通过；路由测试 19 项，全套 `node --test src/*.test.mjs` 通过。
- 独立临时 OMP（隔离 `ORZIC_AGENT_DIR` 与 `--session-dir`，`ORZIC_DRIVER` 未设置）：
  - 钣金拆解原句 → `route phase=planning selector=openai-codex/gpt-6-luna ok=true`，assistant 模型 `gpt-6-luna`。
  - 成功写 `PLAN.md` → 写入完成后才出现 `handoff ... selector=magpie/auto/deepseek-v4.1-flash ok=true`，后续 assistant 模型为 DeepSeek，计划快照生成。
  - 规划模型不可用 → 无 session 文件、无 assistant 回复（`ctx.abort()` 停轮）。
  - 历史 `PLAN.md` 存在但本轮未写 → 不生成快照，仍由规划模型回答。
- 扩展经 `orca plugin restart local.orzic` 同步；`~/.omp/agent/extensions/orzic-loop.ts` 与 `src/orzic-loop.ts` 字节一致。**运行中的 OMP 必须重启（Ctrl+C 后重开）才会加载新版扩展。**

## 结构

| 文件 | 职责 |
|---|---|
| `src/worker.ts` | `fusion.status`/`fusion.set`/`models.list`/`session.status`/`session.list` + 接线 `acceptance.*` handler;`fusion.status` 用一次 `omp config list` 并立即返回磁盘模型快照,`models.list` 单独刷新目录;`installLoopExtension` 把 loop+driver 同步进 `~/.omp/agent/extensions` |
| `src/acceptance.ts` | `acceptance.review`(ompJudge/ocrCli 手动判定)+ `acceptance.result`(读 review.json+lock)+ `acceptance.stop`(写带 run-token 的 stop flag,force 附 kill) |
| `src/cli.ts` | `ompExecutable`(OMP CLI 路径解析)+ `commandError` |
| `src/panel.tsx` | 侧栏:fusion 配置 / 会话卡 / 验收开关+手动验收 / driver 状态条+停止+强杀;配置与模型目录分两路加载 |
| `src/protocol.ts` | `PluginRequests` 声明 + `AcceptanceCfg`/`ReviewVerdict`/`Finding`/`ReviewOut`/`FusionState`/`SessionStatus` |
| `src/orzic-models.mjs` | `omp models ls` 的缓存 + single-flight:并发/重试共享一次 CLI,失败拒绝而不是返回空目录 |
| `src/orzic-loop.ts` | OMP 扩展:新请求切规划模型、只有明确继续才用执行模型;`tool_call` 阻断规划期 `bash`/`eval` 与 PLAN.md 外写入;`tool_execution_end` 确认写入成功且计划非空后才保存快照并切执行;`agent_end` 只启动会话外验收驱动,不从历史文件补办批准 |
| `src/orzic-driver.mjs` | Detached Node driver:锁 + session pin + gitDiff → judge(omp)→ verdict 写盘 → rework 则 `omp -r` 注入;每轮重读 `orzic-acceptance.json` |
| `src/orzic-verdict.mjs` | `--mode json` ndjson → `message_end` assistant text → verdict(`pass`/`rework`/`failed`/`unreviewed`)严格解析,失败不 pass |
| `src/orzic-models.mjs` | 模型目录 60s 缓存 + 单飞;`omp models ls` 失败/超时向上抛错,不降级成空列表 |
| `src/orzic-lock.mjs` | `wx` 原子锁 + heartbeat + stale(10min)回收 |
| `src/orzic-session.mjs` | Session pin 解析:权威 `ORZIC_SESSION_FILE` 路径存在且 cwd 匹配 → `exact`,否则 `scan`(只评审) |
| `src/orzic-stub-omp.mjs` | 测试 stub:录 `orzic-stub-calls.jsonl`,按 `ORZIC_STUB_MODE` 返回 verdict;`ORZIC_STUB_STOP_ON_INJECT` 在 `-r` 里写 stop flag 测 mid-run 截停 |
| `tools/smoke-omp.mjs` | OMP 升级兼容 smoke:隔离目录真实启动 OMP,验证扩展加载、规划路由和实际应答模型;失败退出非零 |

## OMP 升级兼容性

当前验证版本 **OMP 19.1.1**。插件不 import OMP 源码，编译期没有耦合；但运行时依赖下面这些契约，OMP 大版本升级**不保证**兼容：

- 扩展事件：`session_start`、`before_agent_start`、`tool_call`、`tool_execution_end`、`agent_end` 及其字段（`prompt`、`toolCallId`、`input`、`isError`、`willContinue`）
- 扩展 API：`pi.setModel()` 返回 `boolean`、`ctx.abort()`、`ctx.sessionManager.getSessionFile()`、`ctx.modelRegistry.getAvailable()`
- CLI：`omp -r`、`--mode json`、`--model @default`、`--no-session`、`--no-prewalk`、`omp models ls`、`omp config list/set`
- 会话 JSONL：面板读取 `model_change`、`message` 和工具事件；字段改名会让会话卡失效

升级后先跑：

```powershell
npm run typecheck
node --test src/*.test.mjs
npm run smoke:omp
```

`smoke:omp` 会用隔离临时目录真实启动 OMP，验证扩展能加载、`before_agent_start` 能收到 prompt、规划模型实际应答（消耗一次短模型调用）。可用 `ORZIC_SMOKE_PLANNER` / `ORZIC_SMOKE_EXECUTOR` / `ORZIC_OMP_BIN` 覆盖。任一路由契约改形，smoke 会失败。

失败时插件保持 **fail closed**：路由不降级到其他模型，验收只会写 `failed`/`unreviewed`，不会静默 `pass`。需要冻结工作流时固定 OMP 版本，升级前在分支上跑完整 smoke。

## 已知边界

- 计划快照只在**本会话**的 `PLAN.md` 写入工具成功返回（`tool_execution_end` 且 `isError=false`）且最终内容非空时保存；`agent_end` 不会把历史 `PLAN.md` 当成已批准计划。`local://PLAN.md` 仅支持 `write`（用捕获的写入内容），`edit`/`ast_edit` 需要能从磁盘读到最终文件。
- `omp -r` 注入的是**当前 OMP session 文件**;同一 cwd 多个会话时只认 `ORZIC_SESSION_FILE` pin,pin 失败降级为 review-only 而不是猜。由 driver 启动的 `omp -r` 返工轮带 `ORZIC_DRIVER=1`，按设计跳过规划/执行路由。
- Driver 只读捕获时的 `HEAD~1..HEAD`;仅写文件但未提交时即使调用受识别工具触发 hook,也可能评审旧 HEAD 的提交差异;空提交没有可评审 diff。首次验证必须让 OMP 在本轮结束前创建新的非空 commit。
- `prompt_submit` 不再发任何消息：回喂只走 driver 的 `omp -r`;会话内注入会和 driver 撞窗口、还可能把旧 verdict 喂给同 cwd 的兄弟会话。
- **阶段只在进程内**:规划/执行状态保存在扩展内存;OMP 重启或手动 `omp -r` 后第一条消息重新规划。driver 自己的 `omp -r` 带 `ORZIC_DRIVER=1`,跳过路由并显式 `--model @default`,不受此影响。
- verdict/lock/stop 文件按仓库分名(`orzic-review-<key>` 等):多 repo 可并发跑 driver。同一 cwd 下两个会话仍只认 `ORZIC_SESSION_FILE` pin 的那一个;`acceptance.result/stop` 依赖面板给出正确 `repo`。
