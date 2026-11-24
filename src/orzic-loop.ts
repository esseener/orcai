// Orzic loop: plan-first routing + acceptance driver.
//
// Every new request starts on the planner; planning blocks bash and all writes
// except PLAN.md. Only an explicit continuation after a successful PLAN.md
// handoff stays on the executor. `agent_end` still starts external review.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

type PiModel = { provider?: string; id?: string }
type PiEvent = {
  prompt?: string; toolName?: string; willContinue?: boolean
  toolCallId?: string; isError?: boolean
  input?: Record<string, unknown>
}
type PiCtx = {
  cwd: string
  model?: PiModel | null
  modelRegistry?: { getAvailable?(): PiModel[] }
  sessionManager?: { getSessionId?(): unknown; getSessionFile?(): unknown }
  ui?: { notify?(text: string, tone?: string): void }
  abort?(): void
}
type Pi = {
  on(name: string, fn: (event: PiEvent, ctx: PiCtx) => unknown | Promise<unknown>): void
  setModel?(model: PiModel): unknown
  setThinkingLevel?(level: string): unknown
  sendUserMessage?(text: string): unknown
}
type AcceptanceCfg = {
  ocr: boolean; ocrModel: string | null; ocrEffort: string | null; rulePath: string | null
  autoReview: boolean; autoRework: boolean; maxRework: number; autoRoute: boolean
  planner: string | null; executor: string | null
}

const agentRoot = (): string => process.env.ORZIC_AGENT_DIR || join(homedir(), '.omp', 'agent')
const cfgPath = (): string => join(agentRoot(), 'orzic-acceptance.json')
const WRITE_TOOLS = new Set(['edit', 'write', 'bash', 'ast_edit', 'eval', 'notebook'])
const MUTATING = new Set(['edit', 'write', 'ast_edit', 'notebook'])

// Inline copy of repoKeyFor in repokey.mjs — OMP loads extension files
// standalone (no local imports), so the driver's file names and this spawn
// gate must agree on the same per-repo keying.
const repoKey = (cwd: string): string => {
  let n = String(cwd ?? '')
  try { n = realpathSync(n) } catch { /* keep raw */ }
  if (/^[a-zA-Z]:[\\/]/.test(n)) {
    n = n.replace(/\\/g, '/').toLowerCase()
  } else if (n.startsWith('\\\\')) {
    n = n.replace(/\\/g, '/')
  }
  const trimmed = n.replace(/[\\/]+$/, '')
  const norm = trimmed || n
  const hash = createHash('sha256').update(norm).digest('hex').slice(0, 16)
  const leaf = (basename(norm) || 'root').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'root'
  return `${leaf}-${hash}`
}

const readCfg = (): AcceptanceCfg => {
  try {
    const d = JSON.parse(readFileSync(cfgPath(), 'utf8')) as Partial<AcceptanceCfg>
    return {
      ocr: d.ocr === true, ocrModel: typeof d.ocrModel === 'string' ? d.ocrModel : null,
      ocrEffort: typeof d.ocrEffort === 'string' ? d.ocrEffort : null,
      rulePath: typeof d.rulePath === 'string' ? d.rulePath : null,
      autoReview: d.autoReview === true, autoRework: d.autoRework === true,
      maxRework: typeof d.maxRework === 'number' && d.maxRework > 0 ? d.maxRework : 3,
      autoRoute: d.autoRoute === true,
      planner: typeof d.planner === 'string' && d.planner ? d.planner : null,
      executor: typeof d.executor === 'string' && d.executor ? d.executor : null,
    }
  } catch {
    return { ocr: false, ocrModel: null, ocrEffort: null, rulePath: null, autoReview: false, autoRework: false, maxRework: 3, autoRoute: false, planner: null, executor: null }
  }
}

const nodeBin = ['node', 'node.exe', 'C:/Program Files/nodejs/node.exe'].find((p) => {
  try { return p.includes('/') || p.includes('\\\\') ? existsSync(p) : true } catch { return false }
}) ?? 'node'

export default function (pi: Pi): void {
  const boot = (m: string): void => {
    try {
      mkdirSync(agentRoot(), { recursive: true })
      writeFileSync(join(agentRoot(), 'orzic-loop.log'), `${new Date().toISOString()} ${m}\n`, { flag: 'a' })
    } catch { /* best effort */ }
  }
  boot(`extension loaded agentRoot=${agentRoot()}`)

  const wroteSessions = new Set<string>()
  const pinCwds = new Map<string, string>()
  const planning = new Map<string, { cwd: string }>()
  const executing = new Set<string>()
  const pendingPlanWrites = new Map<string, { session: string; turn: number; cwd: string; target: string; content: string | null }>()
  const pendingWrites = new Map<string, { session: string; turn: number; isPlan: boolean; shell: boolean }>()
  const turnBySession = new Map<string, number>()
  let turnSeq = 0

  const pinSession = (ctx?: PiCtx): string => {
    try {
      const f = ctx?.sessionManager?.getSessionFile?.()
      if (typeof f !== 'string' || !f.endsWith('.jsonl')) return ''
      const c = ctx?.cwd
      if (typeof c === 'string' && c) pinCwds.set(f, c)
      return f
    } catch { return '' }
  }

  const modelBySelector = (ctx: PiCtx, selector: string | null): PiModel | undefined => {
    if (!selector) return undefined
    const slash = selector.indexOf('/')
    if (slash <= 0) return undefined
    const provider = selector.slice(0, slash)
    let id = selector.slice(slash + 1)
    const colon = id.lastIndexOf(':')
    if (colon > 0) id = id.slice(0, colon)
    const models = ctx.modelRegistry?.getAvailable?.() ?? []
    return models.find((m) => m.provider === provider && m.id === id)
  }

  const LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  const effortOf = (selector: string | null): string | null => {
    if (!selector) return null
    const c = selector.lastIndexOf(':')
    if (c <= 0) return null
    const level = selector.slice(c + 1).toLowerCase()
    return LEVELS.has(level) ? level : null
  }

  let modelQueue: Promise<unknown> = Promise.resolve()

  const useModel = (ctx: PiCtx, selector: string | null): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      try {
        const target = modelBySelector(ctx, selector)
        if (!target || typeof pi.setModel !== 'function') return false
        // OMP resolves false when the provider has no API key. Anything other
        // than true (false, undefined) means the switch did not happen; the
        // registry read above is also inside this try because it can throw.
        if (await pi.setModel(target) !== true) return false
        const level = effortOf(selector)
        if (level && typeof pi.setThinkingLevel === 'function') {
          const s = pi.setThinkingLevel(level)
          if (s && typeof (s as Promise<unknown>).then === 'function') await s
        }
        return true
      } catch { return false }
    }
    const next = modelQueue.then(run, run)
    modelQueue = next.catch(() => undefined)
    return next
  }

  // A new task always starts with the planner. Only an explicit continuation
  // after a PLAN.md handoff inherits the execution phase; this keeps review and
  // planning requests on the planner instead of guessing from keywords/length.
  const continuation = /^(?:继续(?:执行|实现)?|按计划(?:执行|实现)?|开始(?:执行|实现)?|执行计划|好(?:的)?|可以|行|ok|continue|proceed)[。！!.\s]*$/i
  const isPlanTarget = (target: string): boolean => /(?:^|[\\/:])PLAN\.md$/i.test(target)
  const planFilePath = (cwd: string, target: string): string =>
    /^local:\/\//i.test(target) ? target : isAbsolute(target) ? target : join(cwd, target)

  const planPath = (key: string): string => join(agentRoot(), `orzic-plan-${key}.json`)
  const writePlan = (ctx: PiCtx, content: string): boolean => {
    const text = String(content ?? '')
    if (!text.trim()) return false
    try {
      mkdirSync(agentRoot(), { recursive: true })
      writeFileSync(planPath(repoKey(ctx.cwd)), JSON.stringify({
        approved: true,
        choice: 'auto',
        by: 'extension',
        sessionFile: pinSession(ctx) || null,
        planContent: text.slice(0, 200000),
        digest: createHash('sha256').update(text).digest('hex'),
        at: new Date().toISOString(),
      }, null, 2), 'utf8')
      return true
    } catch { return false }
  }

  pi.on('session_start', async (_e, ctx) => {
    const f = pinSession(ctx)
    boot(`session_start sf=${f}`)
    planning.delete(f)
    executing.delete(f)
    pendingWrites.clear()
    pendingPlanWrites.clear()
    wroteSessions.delete(f)
    turnBySession.set(f, ++turnSeq)
    const cfg = readCfg()
    if (!cfg.autoRoute || process.env.ORZIC_DRIVER || !cfg.planner) return
    const ok = await useModel(ctx, cfg.planner)
    if (ok) ctx.ui?.notify?.(`Orzic: 规划 ${cfg.planner}`, 'info')
  })
  pi.on('agent_start', (_e, ctx) => { pinSession(ctx) })

  pi.on('before_agent_start', async (e, ctx) => {
    const f = pinSession(ctx)
    if (!f) return
    turnBySession.set(f, ++turnSeq)
    const cfg = readCfg()
    if (process.env.ORZIC_DRIVER) return
    if (!cfg.autoRoute) { planning.delete(f); executing.delete(f); return }
    if (typeof e?.prompt !== 'string' || !e.prompt.trim()) return
    const resume = executing.has(f) && continuation.test(e.prompt.trim())
    if (resume) {
      const ok = await useModel(ctx, cfg.executor)
      boot(`route session=${f} phase=executing selector=${cfg.executor} ok=${ok}`)
      if (!ok) {
        ctx.ui?.notify?.(`Orzic: 执行模型不可用 ${cfg.executor}`, 'warning')
        ctx.abort?.()
        throw new Error(`Orzic: 执行模型不可用 ${cfg.executor}`)
      }
      return
    }
    executing.delete(f)
    planning.set(f, { cwd: ctx.cwd })
    if (!cfg.planner) {
      ctx.ui?.notify?.('Orzic: 未配置规划模型，本轮停止。', 'warning')
      ctx.abort?.()
      throw new Error('Orzic: 未配置规划模型')
    }
    const ok = await useModel(ctx, cfg.planner)
    boot(`route session=${f} phase=planning selector=${cfg.planner} ok=${ok}`)
    if (!ok) {
      ctx.ui?.notify?.(`Orzic: 规划模型不可用 ${cfg.planner}`, 'warning')
      // Hook errors are logged and swallowed by the runner; abort is what
      // actually stops this turn from running on the previous model.
      ctx.abort?.()
      throw new Error(`Orzic: 规划模型不可用 ${cfg.planner}`)
    }
    ctx.ui?.notify?.(`Orzic: 规划 ${cfg.planner}`, 'info')
  })

  pi.on('tool_call', async (e, ctx) => {
    const f = pinSession(ctx)
    const name = e?.toolName ?? ''
    const input = e?.input ?? {}
    const target = String(input.path ?? input.file_path ?? input.file ?? '')
    const plan = f ? planning.get(f) : undefined
    const turn = f ? turnBySession.get(f) ?? 0 : 0
    if (!plan) {
      if (f && executing.has(f) && WRITE_TOOLS.has(name) && e.toolCallId) {
        const shell = name === 'bash' || name === 'eval'
        pendingWrites.set(e.toolCallId, { session: f, turn, isPlan: !shell && MUTATING.has(name) && isPlanTarget(target), shell })
      }
      return
    }
    if (name === 'bash' || name === 'eval') return { block: true, reason: '规划阶段只读；计划完成后会自动切换到执行模型。' }
    if (name === 'write' || name === 'edit' || name === 'ast_edit' || name === 'notebook') {
      if (!isPlanTarget(target)) return { block: true, reason: '规划阶段只允许写 PLAN.md；先完成计划。' }
      if (!e.toolCallId) return { block: true, reason: '无法关联工具调用 ID，规划阶段不允许写入。' }
      let content: string | null = null
      if (name === 'write') {
        content = String(input.content ?? '')
        if (!content.trim()) return { block: true, reason: '计划内容为空；请先把完整计划写入 PLAN.md。' }
      }
      pendingWrites.set(e.toolCallId, { session: f, turn, isPlan: true, shell: false })
      // Do not switch here: the tool may still fail or be cancelled. The
      // matching tool_execution_end decides, and agent_end never approves a
      // historical PLAN.md.
      pendingPlanWrites.set(e.toolCallId, { session: f, turn, cwd: ctx.cwd, target, content })
    }
  })

  pi.on('tool_execution_end', async (e, ctx) => {
    if (!e.toolCallId) return
    const f = pinSession(ctx)
    const turn = f ? turnBySession.get(f) ?? -1 : -1
    const write = pendingWrites.get(e.toolCallId)
    if (write) {
      pendingWrites.delete(e.toolCallId)
      // A missing isError is not a success. A nonzero bash/eval exit still
      // counts because the command may have committed before failing; only
      // structured edit/write tools treat isError as "nothing happened".
      const completed = typeof e.isError === 'boolean'
      const mayHaveWritten = write.shell ? completed : e.isError === false
      if (mayHaveWritten && write.session === f && write.turn === turn && !write.isPlan) wroteSessions.add(write.session)
    }
    const pending = pendingPlanWrites.get(e.toolCallId)
    if (!pending) return
    pendingPlanWrites.delete(e.toolCallId)
    if (pending.session !== f || pending.turn !== turn || !planning.has(f)) return
    if (e.isError !== false) { boot(`plan write not confirmed session=${pending.session}`); return }
    let content = pending.content
    if (content === null) {
      const file = planFilePath(pending.cwd, pending.target)
      if (/^local:\/\//i.test(file)) { boot('plan read skipped: local target has no captured content'); return }
      try { content = readFileSync(file, 'utf8') } catch { content = null }
    }
    if (!content || !content.trim()) {
      ctx.ui?.notify?.('Orzic: PLAN.md 为空或读不到，保持规划阶段。', 'warning')
      return
    }
    if (!writePlan(ctx, content)) {
      ctx.ui?.notify?.('Orzic: 计划快照写入失败，保持规划阶段。', 'warning')
      boot(`plan snapshot failed session=${f}`)
      return
    }
    const selector = readCfg().executor
    const ok = await useModel(ctx, selector)
    boot(`handoff session=${f} selector=${selector} ok=${ok}`)
    if (!ok) {
      ctx.ui?.notify?.(`Orzic: 执行模型不可用 ${selector}`, 'warning')
      ctx.abort?.()
      return
    }
    planning.delete(f)
    executing.add(f)
  })

  pi.on('agent_end', (e, ctx) => {
    if (e?.willContinue === true) return
    const self = pinSession(ctx)
    if (self) {
      turnBySession.delete(self)
      for (const [id, w] of pendingWrites) if (w.session === self) pendingWrites.delete(id)
      for (const [id, p] of pendingPlanWrites) if (p.session === self) pendingPlanWrites.delete(id)
    }
    const acc = readCfg()
    const agentRootDir = process.env.ORZIC_AGENT_DIR || join(homedir(), '.omp', 'agent')
    const log = (m: string) => { try { mkdirSync(agentRootDir, { recursive: true }); writeFileSync(join(agentRootDir, 'orzic-loop.log'), `${new Date().toISOString()} ${m}\n`, { flag: 'a' }) } catch { /* best effort */ } }
    if (process.env.ORZIC_DRIVER) { log('driver-run: skip'); return }
    if (!self) { log('agent_end: no session file — skip'); return }
    const wrote = wroteSessions.delete(self) === true
    if (!acc.autoReview || !wrote) { log(`agent_end wrote=${wrote} autoReview=${acc.autoReview}`); return }
    const cwd = pinCwds.get(self) ?? (typeof (ctx as { cwd?: string })?.cwd === 'string' ? (ctx as { cwd?: string }).cwd as string : process.cwd())
    const key = repoKey(cwd)
    log(`agent_end sessionFile=${self}`)
    const lockPath = join(agentRootDir, `orzic-driver-${key}.lock`)
    const lockBusy = () => {
      try {
        for (const entry of readdirSync(lockPath)) {
          if (!entry.startsWith('owner-')) continue
          try {
            const d = JSON.parse(readFileSync(join(lockPath, entry), 'utf8'))
            const t = Date.parse(String(d?.at ?? ''))
            if (d?.token && Number.isFinite(t) && Date.now() - t < 10 * 60_000) return true
          } catch { /* skip */ }
        }
      } catch { /* no lock dir */ }
      return false
    }
    if (lockBusy()) { log('driver already running'); return }
    const driver = join(agentRootDir, 'extensions', 'orzic-driver.mjs')
    if (!existsSync(driver)) { log('no driver'); return }
    try { unlinkSync(join(agentRootDir, `orzic-stop-${key}`)) } catch { /* none */ }
    try {
      const spawnLog = process.env.ORZIC_SPAWN_LOG
      if (spawnLog) {
        writeFileSync(spawnLog, JSON.stringify({ cwd, sessionFile: self, at: new Date().toISOString() }))
        log(`spawn recorded cwd=${cwd}`)
        return
      }
      const child = spawn(nodeBin, [driver], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ORZIC_CWD: cwd, ORZIC_SESSION_FILE: self } })
      child.unref()
      log(`spawned driver pid=${child.pid} cwd=${cwd} pin=exact`)
    } catch (err) { log(`spawn driver failed ${err}`) }
  })
}
