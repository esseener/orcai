<img src="assets/logo5.png" alt="Orzic" height="48">

# Orzic

OMP 原生 plan mode 的侧栏调度器 + 自动验收循环。面板「开始任务」把任务交给规划模型，规划阶段只读；批准计划后退出 plan mode，自动恢复默认执行模型，同一会话继续实现。验收在会话外由独立 judge 对着 diff 和已批准的计划判定。

## 面板标签

- **Orzic**：开始任务、规划/执行模型、验收设置和 OMP 会话状态。
- **便签**：记录运行中的临时想法，支持新建、编辑、删除和持久保存。点击「复制」后手动粘贴到 OMP 输入框并自行提交；便签不会自动注入或发送。

## 规划/执行路由

- **规划模型** = `modelRoles.plan`（进入 plan mode 时切换）
- **执行模型** = `modelRoles.default`（退出 plan mode 时恢复）
- **开始任务** = 面板把 `{sessionFile, goal}` 写进会话邮箱，扩展在 1 秒内进入 plan mode 并发送任务；session 不匹配则忽略
- **自动批准** = 面板发起的任务在 `plan_review_requested` 时调用 `resolvePlanReview(reviewId,'keep')`
- **子代理同规则** = 内置 task 子代理也启用(`task.prewalk`)
- 会话卡实时显示当前模型、最近工具和模型切换时间线；多会话可切换查看

## 验收(Acceptance)

写完代码的轮次自动跑第三方评审，REWORK 自动回喂返工，PASS 收口。**手动路径**(面板「运行验收」)在 worker 内同步跑；**自动路径**由 `orzic-driver.mjs` 在会话外跑。评审输入包含 git diff、规则，以及 `orzic-plan-<repoKey>.json` 里**已批准的计划**；实现偏离计划会被报成 finding。

### 手动验收 `acceptance.review`

- 默认 `ompJudge`:OMP 池模型按 `rule.json` 规则判定(复用 OMP 认证，无需额外凭证)。
- `ocr` 开启+安装后走外部 `ocr review`(SARIF findings → 确定性 verdict)。
- verdict 只有 `pass`/`rework`/`unreviewed`/`failed`/`no-repo`,**只有显式 `pass` 才算过**;空输出、解析失败、未知 verdict 一律 `failed`。

### 自动验收循环(`orzic-driver.mjs`)

`orzic-loop.ts`(OMP 扩展)在 `agent_end` 检测本轮是否调用过受识别的写入工具(`edit`/`write`/`bash`/`ast_edit`/`eval`/`notebook`)以及 `autoReview` → spawn **detached `orzic-driver.mjs`**。这里记录的是工具调用,不是校验文件是否真的变化;driver 跑在 OMP 进程外：

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
node --test src/orzic-driver.test.mjs src/orzic-verdict.test.mjs src/orzic-models.test.mjs
```

## 结构

| 文件 | 职责 |
|---|---|
| `src/worker.ts` | `fusion.status`/`fusion.set`/`models.list`/`session.status`/`session.list` + 接线 `acceptance.*` handler;`fusion.status` 用一次 `omp config list` 并立即返回磁盘模型快照,`models.list` 单独刷新目录;`installLoopExtension` 把 loop+driver 同步进 `~/.omp/agent/extensions` |
| `src/acceptance.ts` | `acceptance.review`(ompJudge/ocrCli 手动判定)+ `acceptance.result`(读 review.json+lock)+ `acceptance.stop`(写带 run-token 的 stop flag,force 附 kill) |
| `src/cli.ts` | `ompExecutable`(OMP CLI 路径解析)+ `commandError` |
| `src/panel.tsx` | 侧栏:fusion 配置 / 会话卡 / 验收开关+手动验收 / driver 状态条+停止+强杀;配置与模型目录分两路加载 |
| `src/protocol.ts` | `PluginRequests` 声明 + `AcceptanceCfg`/`ReviewVerdict`/`Finding`/`ReviewOut`/`FusionState`/`SessionStatus` |
| `src/orzic-models.mjs` | `omp models ls` 的缓存 + single-flight:并发/重试共享一次 CLI,失败拒绝而不是返回空目录 |
| `src/orzic-loop.ts` | OMP 扩展:`before_agent_start` 恢复规划模型;`tool_call` 标 `wroteThisTurn`;`agent_end` 捕获 `ctx.sessionManager.getSessionFile()` → 写 `ORZIC_SESSION_FILE` env → spawn detached driver;`prompt_submit` 自审兜底(仅 `!consumed` rework) |
| `src/orzic-driver.mjs` | Detached Node driver:锁 + session pin + gitDiff → judge(omp)→ verdict 写盘 → rework 则 `omp -r` 注入;每轮重读 `orzic-acceptance.json` |
| `src/orzic-verdict.mjs` | `--mode json` ndjson → `message_end` assistant text → verdict(`pass`/`rework`/`failed`/`unreviewed`)严格解析,失败不 pass |
| `src/orzic-models.mjs` | 模型目录 60s 缓存 + 单飞;`omp models ls` 失败/超时向上抛错,不降级成空列表 |
| `src/orzic-lock.mjs` | `wx` 原子锁 + heartbeat + stale(10min)回收 |
| `src/orzic-session.mjs` | Session pin 解析:权威 `ORZIC_SESSION_FILE` 路径存在且 cwd 匹配 → `exact`,否则 `scan`(只评审) |
| `src/orzic-stub-omp.mjs` | 测试 stub:录 `orzic-stub-calls.jsonl`,按 `ORZIC_STUB_MODE` 返回 verdict;`ORZIC_STUB_STOP_ON_INJECT` 在 `-r` 里写 stop flag 测 mid-run 截停 |

## 已知边界

- 计划快照在批准时从 `local://` 的 artifacts 目录重读最终文件；读不到则标记未批准，judge 不使用草稿。批准choice只认 `keep`/`compact`/`execute`。
- `omp -r` 注入的是**当前 OMP session 文件**;同一 cwd 多个会话时只认 `ORZIC_SESSION_FILE` pin,pin 失败降级为 review-only 而不是猜。
- Driver 只读捕获时的 `HEAD~1..HEAD`;仅写文件但未提交时即使调用受识别工具触发 hook,也可能评审旧 HEAD 的提交差异;空提交没有可评审 diff。首次验证必须让 OMP 在本轮结束前创建新的非空 commit。
- `prompt_submit` 不再发任何消息：回喂只走 driver 的 `omp -r`;会话内注入会和 driver 撞窗口、还可能把旧 verdict 喂给同 cwd 的兄弟会话。
- verdict/lock/stop 文件按仓库分名(`orzic-review-<key>` 等):多 repo 可并发跑 driver。同一 cwd 下两个会话仍只认 `ORZIC_SESSION_FILE` pin 的那一个;`acceptance.result/stop` 依赖面板给出正确 `repo`。
