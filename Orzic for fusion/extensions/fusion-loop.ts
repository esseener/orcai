// Orzic for fusion — OMP extension.
//
// Every user message goes through `orzic-fusion route` before the model runs.
// Hybrid C: new wishes start on the planner, pure questions answer directly,
// and a session keeps its mode until a new wish or an explicit /plan /exec.
// While planning, side-effect tools are blocked and only PLAN.md may be
// written; a successful non-empty PLAN.md hands off to the executor.
import { execFile, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLAN_PROMPT = [
  'Orzic Fusion 规划阶段（本轮只读）：',
  '1. 先用自然语言复述用户这次想要达到的效果。用户可能不写代码，只给自然语言和截图；不要假设他知道文件名或技术名词。',
  '2. 写出可验证的验收标准（用户能看到/点到的结果）。',
  '3. 写出步骤、涉及文件、风险与假设。信息不足时先写假设，不要停下来追问。',
  '4. 把完整计划写入仓库根目录 PLAN.md（必须非空）。',
  '写入成功后会自动切换到执行模型。本轮不要修改其他文件，不要运行 bash/eval，也不要委派 task 子任务。',
].join('\n')

const CONTINUE_MESSAGE = '接着上一个会话继续'
// A save turn on a large session can take minutes; never block the panel forever.
const HANDOFF_WAIT_MS = 10 * 60_000

// MCP tools may be mounted as bash commands, so the tool name is not a stable
// signal. The snapshot itself is: an empty result means no file, and an
// unchanged hash means the save did not land.
function handoffStamp(cwd: string): string {
  try {
    return createHash('sha1')
      .update(readFileSync(join(cwd, '.omp', 'handoff.md'), 'utf8'))
      .digest('hex')
  } catch {
    return ''
  }
}

const REWORK_MARKER = '[Orzic Fusion 自动返工]'
const MAX_REWORK_ROUNDS = 2

// `/gogo` injects this as a normal user message so the model writes the
// snapshot with the tools it already has. The marker lets the routing hook
// recognise the turn: it must run on the executor, never the planner.
const HANDOFF_MARKER = '[Orzic Fusion 交接保存]'
const HANDOFF_PROMPT = [
  `${HANDOFF_MARKER} 用户要求把当前会话保存到项目接续快照，之后会退出并用新会话接着做。`,
  '只做这一件事，不要继续原任务，不要修改其他文件。',
  '1. 调用 fusion_handoff_read（cwd 为当前项目根）读取现有快照与 hash；工具不可用时直接读 .omp/handoff.md。',
  '2. 按本次对话的真实内容写一份简体中文 Markdown：目标、已完成（只写实际做过并验证过的）、关键决定及原因、未完成事项、下一步（带具体文件与仓库相对路径，不要写绝对路径）、重要验证结果。不要编造，不要粘贴整段聊天。',
  '3. 调用 fusion_handoff_save 保存：传 cwd、content，以及第 1 步读到的 hash 作为 expectedHash（此前没有快照则省略）。工具不可用时用 write 写入 .omp/handoff.md，并确保 AGENTS.md 含 `@.omp/handoff.md` 导入行。',
  '4. 读回确认：hash 与 bytes 与写入一致，agentsWired 为 true。',
  '5. 用一句话告诉用户：已保存到 .omp/handoff.md。若自动接续没有生效，再提示按 Ctrl+D 退出，并在同一目录重新运行 omp，说「接着上一个会话继续」。',
].join('\n')

type AutoFinding = {
  severity?: string
  file?: string
  line?: number
  message?: string
}

type AutoResult = {
  verdict?: string
  mode?: string
  autoRework?: boolean
  findings?: AutoFinding[]
  summary?: string
  reason?: string
  stale?: boolean
  fingerprint?: string
}

type ActiveRun = {
  child: ChildProcess
  token: number
}

type RouteDecision = {
  mode?: string
  selector?: string | null
  thinking?: string | null
  effectiveThinking?: string | null
  fallback?: boolean
  error?: string
}

type PiEvent = {
  prompt?: string
  toolName?: string
  toolCallId?: string
  isError?: boolean
  input?: Record<string, unknown>
  willContinue?: boolean
  awaitingAsyncWork?: boolean
}

type PiModel = { provider?: string; id?: string }

type PiContext = {
  cwd?: string
  agent?: { kind?: string }
  ui?: { notify?(text: string, tone?: string): void }
  abort?(): void
  modelRegistry?: { getAvailable?(): PiModel[] }
  sessionManager?: { getSessionId?(): unknown; getSessionFile?(): unknown }
  isIdle?(): boolean
  hasPendingMessages?(): boolean
  shutdown?(): void
}

type PiCommandContext = PiContext

type Pi = {
  on(name: string, fn: (event: PiEvent, ctx: PiContext) => unknown | Promise<unknown>): void
  registerCommand?(name: string, options: {
    description?: string
    handler: (args: string, ctx: PiCommandContext) => Promise<void> | void
  }): void
  setModel?(model: PiModel): unknown
  setThinkingLevel?(level: string): unknown
  sendUserMessage?(content: string, options?: { deliverAs?: string; attribution?: string }): unknown
}

function agentRoot(): string {
  return process.env.ORZIC_AGENT_DIR || join(homedir(), '.omp', 'agent')
}

function installedExe(): string {
  const dir = agentRoot()
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'orzic-fusion-install.json'), 'utf8'))
    if (parsed && typeof parsed === 'object' && 'exe' in parsed && typeof parsed.exe === 'string') {
      return parsed.exe
    }
  } catch { /* fall back to PATH */ }
  return ''
}

const EXE = process.env.ORZIC_FUSION_EXE || installedExe() || 'orzic-fusion.exe'

function sessionId(ctx: PiContext): string {
  try {
    const id = ctx.sessionManager?.getSessionId?.()
    if (id) return String(id)
  } catch { /* fall through */ }
  try {
    const file = ctx.sessionManager?.getSessionFile?.()
    if (file) return String(file)
  } catch { /* fall through */ }
  return 'default'
}

// Memory watch talks to `orzic-fusion mem-report`; it never writes the state
// file itself, so the console and the extension stay on one writer.
const MEMORY_INTERVAL_MS = 5000
let memoryTimer: NodeJS.Timeout | null = null
let memorySession = ''

function memoryLabel(ctx: PiContext): string {
  const id = sessionId(ctx)
  // `default` is the routing fallback, not a real session key.
  return id === 'default' ? `pid:${process.pid}` : id
}

function formatBytes(value: number): string {
  if (!value) return '0 MB'
  const gb = value / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  return `${Math.round(value / 1024 ** 2)} MB`
}

function reportMemory(ctx: PiContext, label: string): void {
  const usage = typeof process.memoryUsage === 'function' ? process.memoryUsage() : null
  const rss = usage?.rss ?? 0
  if (!rss) return
  try {
    const out = execFileSync(EXE, ['mem-report'], {
      input: JSON.stringify({
        agent: 'omp',
        sessionId: label,
        pid: process.pid,
        rssBytes: rss,
        cwd: ctx.cwd ?? process.cwd(),
        scope: 'process',
        note: 'OMP 主进程常驻内存；同一进程内的会话共享',
      }),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    })
    const result = JSON.parse(out) as { alert?: boolean; thresholdBytes?: number }
    if (result.alert) {
      ctx.ui?.notify?.(
        `Orzic Fusion：本会话进程内存 ${formatBytes(rss)}，超过 ${formatBytes(result.thresholdBytes ?? 0)} 预警线。` +
          '先整理进度再开新对话（/new，旧会话保留）；新对话不保证释放进程内存。',
        'warning',
      )
    }
  } catch { /* sampling must never break a turn */ }
}

function startMemoryWatch(ctx: PiContext, label: string): void {
  if (memorySession === label && memoryTimer) {
    reportMemory(ctx, label)
    return
  }
  if (memoryTimer) {
    clearInterval(memoryTimer)
    memoryTimer = null
  }
  memorySession = label
  reportMemory(ctx, label)
  memoryTimer = setInterval(() => reportMemory(ctx, label), MEMORY_INTERVAL_MS)
  memoryTimer.unref?.()
}

function asDecision(value: unknown): RouteDecision {
  if (!value || typeof value !== 'object') return {}
  return {
    mode: 'mode' in value && typeof value.mode === 'string' ? value.mode : undefined,
    selector: 'selector' in value && typeof value.selector === 'string' ? value.selector : null,
    thinking: 'thinking' in value && typeof value.thinking === 'string' ? value.thinking : null,
    effectiveThinking: 'effectiveThinking' in value && typeof value.effectiveThinking === 'string'
      ? value.effectiveThinking
      : null,
    fallback: 'fallback' in value && value.fallback === true,
    error: 'error' in value && typeof value.error === 'string' ? value.error : undefined,
  }
}

function callRoute(args: string[], input: string): RouteDecision {
  const out = execFileSync(EXE, ['route', ...args, '--json'], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  })
  return asDecision(JSON.parse(out))
}

function splitSelector(selector: string, thinking: string | null): { provider: string; id: string } | null {
  const slash = selector.indexOf('/')
  if (slash <= 0) return null
  const provider = selector.slice(0, slash)
  let id = selector.slice(slash + 1)
  if (thinking) {
    const suffix = `:${thinking.toLowerCase()}`
    if (id.toLowerCase().endsWith(suffix)) id = id.slice(0, -suffix.length)
  }
  return { provider, id }
}

async function useModel(pi: Pi, ctx: PiContext, decision: RouteDecision): Promise<boolean> {
  if (!decision.selector) return false
  const target = splitSelector(decision.selector, decision.thinking ?? null)
  if (!target) return false
  const models = ctx.modelRegistry?.getAvailable?.() ?? []
  const model = models.find((entry) => entry.provider === target.provider && entry.id === target.id)
  if (!model || typeof pi.setModel !== 'function') return false
  let ok
  try {
    ok = await pi.setModel(model)
  } catch {
    return false
  }
  if (ok !== true) return false
  const level = decision.effectiveThinking ?? decision.thinking ?? null
  if (level && typeof pi.setThinkingLevel === 'function') {
    try {
      await pi.setThinkingLevel(level)
    } catch { /* the model still runs at the session level */ }
  }
  return true
}

// The native launcher (`bin/omp-launcher.exe`) runs `omp` in the foreground of
// the same terminal. The marker carries its per-run token, so only the run
// that asked to be replaced is relaunched, in that project, once.
function armRelaunch(cwd: string, session: string): boolean {
  const dir = join(cwd, '.omp')
  const target = join(dir, 'gogo-restart.json')
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({
        run: process.env.ORZIC_OMP_RUN ?? '',
        pid: process.pid,
        cwd,
        session,
        message: CONTINUE_MESSAGE,
        at: Date.now(),
      }),
    )
    renameSync(tmp, target)
    return true
  } catch {
    return false
  }
}

export default function (pi: Pi): void {
  const phases = new Map<string, string>()
  const pendingPlanWrites = new Map<string, string>()
  const turnTokens = new Map<string, number>()
  const reworkCounts = new Map<string, number>()
  const autoRuns = new Map<string, ActiveRun>()
  // A handoff turn is an explicit save request: it must not be auto-reviewed.
  const handoffTurns = new Set<string>()
  const mainOnly = (ctx: PiContext) => ctx.agent?.kind !== 'sub'

  const cancelAutoRun = (id: string) => {
    const run = autoRuns.get(id)
    if (!run) return
    autoRuns.delete(id)
    const cleanupLock = () => {
      const path = join(agentRoot(), 'orzic-fusion-acceptance.lock')
      try {
        const owner = readFileSync(path, 'utf8').trim().split(/\s+/)[0]
        if (run.child.pid && owner === String(run.child.pid)) unlinkSync(path)
      } catch { /* no lock, or another review owns it */ }
    }
    try {
      if (process.platform === 'win32' && run.child.pid) {
        execFile(
          'taskkill',
          ['/PID', String(run.child.pid), '/T', '/F'],
          { windowsHide: true },
          cleanupLock,
        )
      } else {
        run.child.kill()
        setTimeout(cleanupLock, 200)
      }
    } catch {
      cleanupLock()
    }
  }

  const runAutoAccept = (id: string, cwd: string, token: number): Promise<AutoResult> => {
    const { promise, resolve, reject } = Promise.withResolvers<AutoResult>()
    const child = execFile(
      EXE,
      ['accept', '--auto', '--json', '--cwd', cwd],
      { windowsHide: true, timeout: 240000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        const current = autoRuns.get(id)
        if (current?.token === token) autoRuns.delete(id)
        if (error) {
          reject(error)
          return
        }
        try {
          resolve(JSON.parse(stdout) as AutoResult)
        } catch (parseError) {
          reject(parseError)
        }
      },
    )
    autoRuns.set(id, { child, token })
    return promise
  }

  const autoReview = async (
    ctx: PiContext,
    id: string,
    cwd: string,
    token: number,
  ): Promise<void> => {
    if (autoRuns.has(id)) return
    let result: AutoResult
    try {
      result = await runAutoAccept(id, cwd, token)
    } catch (error) {
      if (turnTokens.get(id) !== token) return
      ctx.ui?.notify?.(
        `Orzic Fusion 自动验收失败：${error instanceof Error ? error.message : String(error)}`,
        'warning',
      )
      return
    }
    if (turnTokens.get(id) !== token) return
    if (!result || typeof result !== 'object') return
    const verdict = String(result.verdict || '')
    if (verdict === 'disabled' || verdict === 'duplicate' || verdict === 'skip') return
    if (verdict === 'pass') {
      ctx.ui?.notify?.('Orzic Fusion 自动验收：PASS', 'info')
      return
    }
    if (verdict === 'stale') {
      ctx.ui?.notify?.('Orzic Fusion 自动验收：工作区在评审期间发生变化，未自动返工', 'warning')
      return
    }
    if (verdict !== 'rework') {
      ctx.ui?.notify?.(`Orzic Fusion 自动验收：${verdict || '未知结果'}`, 'warning')
      return
    }

    const findings = Array.isArray(result.findings) ? result.findings : []
    if (!findings.length) {
      ctx.ui?.notify?.('Orzic Fusion 自动验收：REWORK 但没有可执行 findings，未自动返工', 'warning')
      return
    }
    if (!result.autoRework) {
      ctx.ui?.notify?.('Orzic Fusion 自动验收：REWORK（自动回喂未开启）', 'warning')
      return
    }
    const count = reworkCounts.get(id) ?? 0
    if (count >= MAX_REWORK_ROUNDS) {
      ctx.ui?.notify?.(
        `Orzic Fusion：已达到自动返工上限（${MAX_REWORK_ROUNDS} 轮），请手动处理`,
        'warning',
      )
      return
    }

    const lines = findings.slice(0, 12).map((finding) => {
      const location = `${finding.file || ''}${finding.line ? `:${finding.line}` : ''}`
      return `- ${finding.severity || 'info'} ${location} — ${finding.message || ''}`
    })
    const text = [
      `${REWORK_MARKER} ${count + 1}/${MAX_REWORK_ROUNDS}`,
      '验收未通过。请按以下 findings 修正后结束本轮；不要扩大范围。',
      ...lines,
    ].join('\n')
    if (turnTokens.get(id) !== token) return
    try {
      if (typeof pi.sendUserMessage !== 'function') {
        throw new Error('当前 OMP 不支持 sendUserMessage')
      }
      await pi.sendUserMessage(text, { attribution: 'agent' })
      reworkCounts.set(id, count + 1)
      ctx.ui?.notify?.(
        `Orzic Fusion 自动验收：REWORK，已回喂执行模型（${count + 1}/${MAX_REWORK_ROUNDS}）`,
        'warning',
      )
    } catch (error) {
      ctx.ui?.notify?.(
        `Orzic Fusion 自动返工注入失败：${error instanceof Error ? error.message : String(error)}`,
        'warning',
      )
    }
  }

  pi.on('session_start', async (_event: PiEvent, ctx: PiContext) => {
    if (!mainOnly(ctx)) return
    const id = sessionId(ctx)
    phases.delete(id)
    turnTokens.delete(id)
    reworkCounts.delete(id)
    cancelAutoRun(id)
    try {
      callRoute(['--event', 'refresh', '--session', id], '')
    } catch { /* the first turn will retry */ }
    startMemoryWatch(ctx, memoryLabel(ctx))
  })

  pi.on('before_agent_start', async (event: PiEvent, ctx: PiContext) => {
    if (!mainOnly(ctx)) return
    if (typeof event.prompt !== 'string' || !event.prompt.trim()) return
    const id = sessionId(ctx)
    const cwd = ctx.cwd ?? process.cwd()

    turnTokens.set(id, (turnTokens.get(id) ?? 0) + 1)
    const isRework = event.prompt.startsWith(REWORK_MARKER)
    const isHandoff = event.prompt.startsWith(HANDOFF_MARKER)
    if (!isRework) {
      reworkCounts.set(id, 0)
      cancelAutoRun(id)
    }

    if (isRework) {
      let decision: RouteDecision
      try {
        decision = callRoute(['--event', 'rework', '--session', id, '--cwd', cwd], '')
      } catch (error) {
        ctx.ui?.notify?.(`Orzic Fusion 返工路由失败：${error instanceof Error ? error.message : String(error)}`, 'warning')
        ctx.abort?.()
        return
      }
      if (decision.error) {
        ctx.ui?.notify?.(`Orzic Fusion：${decision.error}`, 'warning')
        phases.set(id, 'execute')
        return
      }
      const ok = await useModel(pi, ctx, decision)
      phases.set(id, 'execute')
      ctx.ui?.notify?.(
        ok
          ? 'Orzic Fusion：自动返工，保持执行模型'
          : `Orzic Fusion：返工模型不可用 ${decision.selector ?? ''}，沿用当前模型`,
        ok ? 'info' : 'warning',
      )
      return
    }

    if (isHandoff) {
      // Explicit user command: run on the executor and never inject the plan
      // prompt, even when the session was still planning.
      handoffTurns.add(id)
      let decision: RouteDecision
      try {
        decision = callRoute(['--event', 'handoff', '--session', id, '--cwd', cwd], '')
      } catch (error) {
        ctx.ui?.notify?.(`Orzic Fusion 交接路由失败：${error instanceof Error ? error.message : String(error)}`, 'warning')
        phases.set(id, 'execute')
        return
      }
      if (decision.error) {
        ctx.ui?.notify?.(`Orzic Fusion：${decision.error}`, 'warning')
        phases.set(id, 'execute')
        return
      }
      const ok = await useModel(pi, ctx, decision)
      phases.set(id, 'execute')
      ctx.ui?.notify?.(
        ok
          ? `Orzic Fusion：交接保存，执行模型 ${decision.selector ?? ''}`
          : 'Orzic Fusion：交接保存，执行模型不可用，沿用当前模型',
        ok ? 'info' : 'warning',
      )
      return
    }

    let decision: RouteDecision
    try {
      decision = callRoute(['--session', id, '--cwd', cwd], event.prompt)
    } catch (error) {
      ctx.ui?.notify?.(`Orzic Fusion 路由失败：${error instanceof Error ? error.message : String(error)}`, 'warning')
      return
    }
    if (decision.error) {
      ctx.ui?.notify?.(`Orzic Fusion：${decision.error}`, 'warning')
      return
    }

    const ok = await useModel(pi, ctx, decision)
    if (!ok) {
      ctx.ui?.notify?.(`Orzic Fusion：模型不可用 ${decision.selector ?? ''}，沿用当前模型`, 'warning')
    }
    phases.set(id, decision.mode ?? 'plan')

    if (decision.mode === 'plan') {
      const suffix = decision.fallback ? '（规划角色未配置，暂用执行模型）' : ''
      ctx.ui?.notify?.(`Orzic Fusion：规划 ${decision.selector}${suffix}`, 'info')
      return {
        message: {
          customType: 'fusion-plan',
          display: false,
          content: PLAN_PROMPT,
        },
      }
    }
    ctx.ui?.notify?.(`Orzic Fusion：执行 ${decision.selector}`, 'info')
    return
  })

  pi.on('tool_call', async (event: PiEvent, ctx: PiContext) => {
    if (!mainOnly(ctx)) return
    const id = sessionId(ctx)
    if (phases.get(id) !== 'plan') return
    const name = event.toolName ?? ''
    // The handoff tools are the explicit save path (`/gogo`), not a task
    // side effect: they stay available even while planning.
    if (name === 'fusion_handoff_read' || name === 'fusion_handoff_save') return
    const input = event.input ?? {}
    const target = typeof input.path === 'string'
      ? input.path
      : typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.file === 'string'
          ? input.file
          : ''

    if (name === 'task') {
      return { block: true, reason: '规划阶段只读：先把计划写入 PLAN.md，再委派执行。' }
    }
    if (name === 'bash' || name === 'eval') {
      return { block: true, reason: '规划阶段只读：计划写入 PLAN.md 后会自动切换到执行模型。' }
    }
    if (name === 'write' || name === 'edit' || name === 'ast_edit' || name === 'notebook') {
      if (!/(^|[\\/])PLAN\.md$/i.test(target)) {
        return { block: true, reason: '规划阶段只允许写 PLAN.md。' }
      }
      if (name === 'write' && !String(input.content ?? '').trim()) {
        return { block: true, reason: '计划内容为空；请先把完整计划写入 PLAN.md。' }
      }
      if (event.toolCallId) pendingPlanWrites.set(String(event.toolCallId), id)
      return
    }
  })

  pi.on('tool_execution_end', async (event: PiEvent, ctx: PiContext) => {
    if (!mainOnly(ctx)) return
    const toolCallId = event.toolCallId ? String(event.toolCallId) : ''
    if (!toolCallId || !pendingPlanWrites.has(toolCallId)) return
    const id = pendingPlanWrites.get(toolCallId)
    if (!id) return
    pendingPlanWrites.delete(toolCallId)
    if (event.isError !== false) return

    const cwd = ctx.cwd ?? process.cwd()
    let content = ''
    try {
      content = readFileSync(join(cwd, 'PLAN.md'), 'utf8')
    } catch { /* missing file is reported below */ }
    if (!content.trim()) {
      ctx.ui?.notify?.('Orzic Fusion：PLAN.md 为空，保持规划阶段。', 'warning')
      return
    }

    let decision: RouteDecision
    try {
      decision = callRoute(['--event', 'plan-written', '--session', id, '--cwd', cwd], '')
    } catch (error) {
      ctx.ui?.notify?.(`Orzic Fusion：计划已写入，但切换失败：${error instanceof Error ? error.message : String(error)}`, 'warning')
      return
    }
    if (decision.error) {
      ctx.ui?.notify?.(`Orzic Fusion：${decision.error}`, 'warning')
      return
    }

    phases.set(id, 'execute')
    const ok = await useModel(pi, ctx, decision)
    ctx.ui?.notify?.(
      ok ? 'Orzic Fusion：计划已捕获，切换到执行模型。' : 'Orzic Fusion：计划已捕获，但执行模型不可用。',
      ok ? 'info' : 'warning',
    )
  })

  pi.on('agent_end', (event: PiEvent, ctx: PiContext) => {
    if (!mainOnly(ctx)) return
    const id = sessionId(ctx)
    if (event.willContinue === true || event.awaitingAsyncWork === true) return
    // A handoff save must not spend another model turn on acceptance.
    if (handoffTurns.delete(id)) return
    if (phases.get(id) !== 'execute') return
    if (autoRuns.has(id)) return
    const cwd = ctx.cwd ?? process.cwd()
    const token = turnTokens.get(id) ?? 0
    void autoReview(ctx, id, cwd, token)
  })

  // Command handlers are killed after 30s (EXTENSION_HANDLER_TIMEOUT_MS), so
  // the save turn is watched from a timer instead of from the handler itself.
  let gogoWatch: { timer: NodeJS.Timeout } | null = null
  const cancelGogoWatch = () => {
    if (!gogoWatch) return
    clearInterval(gogoWatch.timer)
    gogoWatch = null
  }
  const watchHandoffSave = (
    ctx: PiCommandContext,
    cwd: string,
    session: string,
    before: string,
  ) => {
    cancelGogoWatch()
    const deadline = Date.now() + HANDOFF_WAIT_MS
    let last = before
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        cancelGogoWatch()
        ctx.ui?.notify?.(
          'Orzic Fusion：未在时限内完成快照保存与会话收尾，已留在当前会话；可重试 /gogo。',
          'warning',
        )
        return
      }
      const now = handoffStamp(cwd)
      if (now === '' || now === before) return
      // The model rewrites the snapshot while verifying it; only take over once
      // the file has stopped changing.
      if (now !== last) {
        last = now
        return
      }
      if (typeof ctx.isIdle !== 'function' || typeof ctx.hasPendingMessages !== 'function') {
        cancelGogoWatch()
        ctx.ui?.notify?.(
          'Orzic Fusion：快照已保存，但无法确认会话空闲；请按 Ctrl+D 后重新运行 omp，说「接着上一个会话继续」。',
          'warning',
        )
        return
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return
      cancelGogoWatch()
      // Only the launcher knows how to start the next omp in this console.
      // Without it, exiting would just drop the user at a shell prompt.
      if (!process.env.ORZIC_OMP_RUN) {
        ctx.ui?.notify?.(
          'Orzic Fusion：快照已保存。当前 OMP 不是从 omp 入口启动的，无法自动重启；请按 Ctrl+D 后在同一个终端重新运行 omp，说「接着上一个会话继续」。',
          'warning',
        )
        return
      }
      if (typeof ctx.shutdown !== 'function') {
        ctx.ui?.notify?.(
          'Orzic Fusion：进度已保存，但当前 OMP 不支持自动退出；请按 Ctrl+D 后重新运行 omp，说「接着上一个会话继续」。',
          'warning',
        )
        return
      }
      if (!armRelaunch(cwd, session)) {
        ctx.ui?.notify?.(
          'Orzic Fusion：进度已保存，但无法写入重启标记（.omp/gogo-restart.json）；请按 Ctrl+D 后重新运行 omp。',
          'warning',
        )
        return
      }
      ctx.ui?.notify?.('Orzic Fusion：快照已保存，正在同一个窗口重启 OMP…', 'info')
      ctx.shutdown()
    }, 1500)
    timer.unref?.()
    gogoWatch = { timer }
  }

  // `/gogo`: save the current progress, then exit so the native launcher
  // (`bin/omp-launcher.exe`) can start a brand-new omp in this same terminal.
  // The marker names the launcher run, so only this run is replaced once.
  // `/gogo keep` saves without exiting.
  pi.registerCommand?.('gogo', {
    description: '保存当前进度并在同一个窗口重启 OMP 接着做；加 keep 只保存',
    handler: async (args, ctx) => {
      if (ctx?.agent?.kind === 'sub') return
      if (typeof pi.sendUserMessage !== 'function') {
        ctx?.ui?.notify?.('Orzic Fusion：当前 OMP 不支持注入消息，/gogo 无法保存', 'warning')
        return
      }
      const id = sessionId(ctx)
      const cwd = ctx.cwd ?? process.cwd()
      const keep = /(^|\s)(keep|只保存|不重启)(\s|$)/i.test(String(args ?? ''))
      const before = handoffStamp(cwd)
      ctx?.ui?.notify?.(
        keep
          ? 'Orzic Fusion：正在整理本次会话并写入 .omp/handoff.md …'
          : 'Orzic Fusion：正在保存进度；成功后会在同一个窗口重启 OMP 接续。',
        'info',
      )
      // Do not await this: in the TUI the returned promise settles only after
      // the queued prompt is consumed, which is the turn we are waiting for.
      const pending = pi.sendUserMessage(HANDOFF_PROMPT, { deliverAs: 'followUp' })
      if (pending && typeof (pending as Promise<unknown>).then === 'function') {
        ;(pending as Promise<unknown>).catch((error) => {
          ctx?.ui?.notify?.(
            `Orzic Fusion：保存请求未能进入会话：${error instanceof Error ? error.message : String(error)}`,
            'warning',
          )
        })
      }
      if (keep) return
      watchHandoffSave(ctx, cwd, id, before)
    },
  })
}
