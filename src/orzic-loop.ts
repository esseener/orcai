// Orzic loop: per-message routing + acceptance driver.
//
// 每条用户消息先交给一个便宜的分类器（executor 模型）判断：需要拆解就切规划
// 模型，规划阶段用 tool_call 阻断除 PLAN.md 外的写入；写完 PLAN.md 立刻切回
// 执行模型。不需要拆解则直接用执行模型。`agent_end` 仍启动会话外验收驱动。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

type PiModel = { provider?: string; id?: string }
type PiEvent = {
  prompt?: string; toolName?: string; willContinue?: boolean
  input?: Record<string, unknown>
}
type PiCtx = {
  cwd: string
  model?: PiModel | null
  modelRegistry?: { getAvailable?(): PiModel[] }
  sessionManager?: { getSessionId?(): unknown; getSessionFile?(): unknown }
  ui?: { notify?(text: string, tone?: string): void }
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
      const target = modelBySelector(ctx, selector)
      if (!target || typeof pi.setModel !== 'function') return false
      try {
        const r = pi.setModel(target)
        if (r && typeof (r as Promise<unknown>).then === 'function') await r
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

  // 零延迟启发式分类：OMP 启动一次要十几秒，消息级等不起模型判定。
  // 明确延续/问答走 direct；跨文件或含拆解语义走 plan；其余按长度兜底。
  const classify = async (_ctx: PiCtx, text: string): Promise<'plan' | 'direct'> => {
    const t = String(text ?? '').trim()
    if (!t) return 'direct'
    if (t.length < 12 || /^(继续|好的|好|行|可以|ok|谢谢|再试|重试|跑一下|改一下)/i.test(t)) return 'direct'
    if (t.length < 60 && /[?？]|吗$|什么|为什么|怎么用/.test(t)) return 'direct'
    if (/(拆解|重构|迁移|实现|设计|方案|排查|跨文件|多个文件|先.*再|步骤|规划|架构|验收|测试|修复|bug|需求)/i.test(t)) return 'plan'
    return t.length > 80 ? 'plan' : 'direct'
  }

  const planPath = (key: string): string => join(agentRoot(), `orzic-plan-${key}.json`)
  const writePlan = (ctx: PiCtx, content: string): void => {
    const text = String(content ?? '')
    if (!text.trim()) return
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
    } catch { /* best effort */ }
  }

  pi.on('session_start', async (_e, ctx) => {
    boot(`session_start sf=${pinSession(ctx)}`)
    const cfg = readCfg()
    if (!cfg.autoRoute || process.env.ORZIC_DRIVER || !cfg.planner) return
    const ok = await useModel(ctx, cfg.planner)
    if (ok) ctx.ui?.notify?.(`Orzic: 规划 ${cfg.planner}`, 'info')
  })
  pi.on('agent_start', (_e, ctx) => { pinSession(ctx) })

  pi.on('before_agent_start', async (e, ctx) => {
    const f = pinSession(ctx)
    if (!f) return
    planning.delete(f)
    const cfg = readCfg()
    if (process.env.ORZIC_DRIVER) return
    if (!cfg.autoRoute) { await useModel(ctx, cfg.executor); return }
    if (typeof e?.prompt !== 'string' || !e.prompt.trim()) return
    const route = await classify(ctx, e.prompt)
    if (route === 'plan' && cfg.planner) {
      planning.set(f, { cwd: ctx.cwd })
      const ok = await useModel(ctx, cfg.planner)
      if (!ok) planning.delete(f)
      ctx.ui?.notify?.(ok ? `Orzic: 规划 ${cfg.planner}` : `Orzic: 规划模型不可用 ${cfg.planner}`, ok ? 'info' : 'warning')
    } else {
      const ok = await useModel(ctx, cfg.executor)
      ctx.ui?.notify?.(ok ? 'Orzic: 直接执行' : `Orzic: 执行模型不可用 ${cfg.executor}`, ok ? 'info' : 'warning')
    }
  })

  pi.on('tool_call', async (e, ctx) => {
    const f = pinSession(ctx)
    const name = e?.toolName ?? ''
    const input = e?.input ?? {}
    const target = String(input.path ?? input.file_path ?? input.file ?? '')
    if (f && WRITE_TOOLS.has(name)) wroteSessions.add(f)
    const plan = f ? planning.get(f) : undefined
    if (!plan) return
    if (name === 'bash') return { block: true, reason: '规划阶段只读；计划完成后会自动切换到执行模型。' }
    if (name === 'write' || name === 'edit' || name === 'ast_edit' || name === 'notebook') {
      if (!/PLAN\.md$/i.test(target)) return { block: true, reason: '规划阶段只允许写 PLAN.md；先完成计划。' }
      if (name === 'write') {
        writePlan(ctx, String(input.content ?? ''))
        planning.delete(f)
      }
      const ok = await useModel(ctx, readCfg().executor)
      boot(`plan switch selector=${readCfg().executor} ok=${ok} model=${ctx.model?.provider}/${ctx.model?.id}`)
    }
  })

  pi.on('agent_end', (e, ctx) => {
    const f = pinSession(ctx)
    const plan = f ? planning.get(f) : undefined
    if (plan) {
      try {
        const p = join(plan.cwd, 'PLAN.md')
        if (existsSync(p)) writePlan(ctx, readFileSync(p, 'utf8'))
      } catch { /* best effort */ }
      if (f) planning.delete(f)
    }
    if (e?.willContinue === true) return
    const self = f
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
