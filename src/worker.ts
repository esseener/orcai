import { execFile } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import type { AcceptanceCfg, FusionState, ModelSwitch, OmpModel, SessionStage, SessionStatus } from './protocol'
import { commandError, ompExecutable } from './cli'
import { acceptanceResult, acceptanceReview, acceptanceStop } from './acceptance'
import { createModelCatalog, MODELS_TIMEOUT_MS, parseModelRows } from './orzic-models.mjs'

// Ship the in-session acceptance loop and detached review driver to OMP's
// extension directory. Model routing remains owned by OMP's native prewalk.

function writeFileSafe(path: string, data: string): void {
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data, 'utf8') } catch { /* best-effort */ }
}
function installLoopExtension(): void {
  try {
    // ESM worker 没有 __dirname;import.meta.url 指向 src/worker.ts(dev load)。
    const here = fileURLToPath(new URL('.', import.meta.url))
    const src = readFileSync(join(here, 'orzic-loop.ts'), 'utf8')
    const dir = join(homedir(), '.omp', 'agent', 'extensions')
    mkdirSync(dir, { recursive: true })
    const dst = join(dir, 'orzic-loop.ts')
    if (!existsSync(dst) || readFileSync(dst, 'utf8') !== src) writeFileSync(dst, src, 'utf8')
    // 外部 loop driver(agent_end detached spawn):评审+REWORK 注入在 OMP 外跑,不挂死。
    // driver 依赖 orzic-verdict/orzic-lock/orzic-session/orzic-repokey 四个模块,一起同步。
    for (const mod of ['orzic-driver.mjs', 'orzic-verdict.mjs', 'orzic-lock.mjs', 'orzic-session.mjs', 'orzic-repokey.mjs']) {
      const modSrc = readFileSync(join(here, mod), 'utf8')
      const modDst = join(dir, mod)
      if (!existsSync(modDst) || readFileSync(modDst, 'utf8') !== modSrc) writeFileSync(modDst, modSrc, 'utf8')
    }
    // Legacy global (pre-repoKey) state files — orphans from before the per-repo keying.
    // Any file matching orzic-review.json / orzic-driver.(lock|log) / orzic-stop
    // with NO key suffix is stale; new code never reads it.
    try {
      const agentDir = join(homedir(), '.omp', 'agent')
      for (const f of ['orzic-review.json', 'orzic-driver.lock', 'orzic-driver.log', 'orzic-stop', 'orzic-pending.json']) {
        const p = join(agentDir, f)
        // .lock may now be a DIRECTORY (per-owner entries); rmSync covers both.
        if (existsSync(p)) rmSync(p, { recursive: true, force: true })
      }
      // Stale keyed lock DIRS (no fresh owner entry) self-expire — clean opportunistically.
      for (const f of readdirSync(agentDir)) {
        if (!/^orzic-driver-.+\.lock$/.test(f)) continue
        const p = join(agentDir, f)
        try {
          if (!statSync(p).isDirectory()) continue // legacy file lock — acquireLock handles staleness
          const live = readdirSync(p).some((e) => e.startsWith('owner-'))
          if (!live) rmSync(p, { recursive: true, force: true })
        } catch { /* skip */ }
      }
    } catch { /* orphan cleanup best-effort */ }
    // OMP may persist the same Windows path with either separator style.
    // Keep one canonical entry without disturbing other user extensions.
    void ompCli<{ value?: unknown[] }>('config', 'get', 'extensions').then((row) => {
      const key = (value: unknown) => typeof value === 'string'
        ? resolve(value).replace(/[\\/]+$/, '').toLowerCase()
        : null
      const target = key(dst)
      const list = Array.isArray(row?.value) ? row.value : []
      const normalized = [...list.filter((entry) => key(entry) !== target), dst]
      if (JSON.stringify(list) !== JSON.stringify(normalized)) {
        void ompCli('config', 'set', 'extensions', JSON.stringify(normalized)).catch(() => undefined)
      }
    }).catch(() => undefined)
  } catch { /* extension install is best-effort */ }
}

function ompCli<T>(...args: string[]): Promise<T> {
  const env = { ...process.env }
  if (process.platform === 'win32' && !env.APPDATA) env.APPDATA = join(homedir(), 'AppData', 'Roaming')
  return new Promise((resolve, reject) => {
    execFile(ompExecutable, [...args, '--json'], {
      encoding: 'utf8', env, windowsHide: true, timeout: args[0] === 'models' ? MODELS_TIMEOUT_MS : 15_000, maxBuffer: 16 * 1024 * 1024
    }, (error, stdout) => {
      if (error) return reject(commandError(`无法运行 OMP ${args.slice(0, 2).join(' ')}。CLI:${ompExecutable}`))
      try { resolve(JSON.parse(stdout) as T) } catch { reject(commandError(`OMP ${args.slice(0, 2).join(' ')} 返回了无法解析的输出。`)) }
    })
  })
}

type ConfigRow = { value?: unknown }
let configCache: { at: number; rows: Record<string, ConfigRow> } | null = null

// One `omp config list` returns every key with its value (644 keys, 126 KiB,
// ~1.3s) instead of six separate `config get` processes. Failures reject:
// returning {} would render plausible defaults and hide a broken OMP install.
async function configCatalog(): Promise<Record<string, ConfigRow>> {
  if (configCache && Date.now() - configCache.at < 15_000) return configCache.rows
  const rows = await ompCli<Record<string, ConfigRow>>('config', 'list')
  configCache = { at: Date.now(), rows: rows ?? {} }
  return configCache.rows
}
function configValue(rows: Record<string, ConfigRow>, key: string): unknown {
  return rows[key]?.value
}
async function ompConfigSet(key: string, value: unknown): Promise<void> {
  await ompCli('config', 'set', key, typeof value === 'string' ? value : JSON.stringify(value))
}

const MODEL_CACHE_FILE = join(homedir(), '.omp', 'agent', 'orzic-models.json')
let modelSnapshot: OmpModel[] = (() => {
  try {
    const d = JSON.parse(readFileSync(MODEL_CACHE_FILE, 'utf8')) as { models?: OmpModel[] }
    return Array.isArray(d.models) ? d.models : []
  } catch { return [] }
})()

const ompModelCatalog = createModelCatalog({
  run: async (): Promise<OmpModel[]> => {
    const receipt = await ompCli<{ models?: unknown }>('models', 'ls')
    return parseModelRows(receipt?.models)
  }
})

async function refreshModelCatalog(force = false): Promise<OmpModel[]> {
  const models = await ompModelCatalog(force)
  modelSnapshot = models
  // Persist successful empty listings too: a stale non-empty snapshot must not
  // outlive a catalog that now reports no models.
  writeFileSafe(MODEL_CACHE_FILE, JSON.stringify({ at: Date.now(), models }))
  return models
}

function split(v: unknown): { model: string | null; effort: string | null } {
  if (typeof v !== 'string' || !v) return { model: null, effort: null }
  const i = v.lastIndexOf(':')
  return i > 0 ? { model: v.slice(0, i), effort: v.slice(i + 1) } : { model: v, effort: null }
}
function join2(model: string | null, effort: string | null): string | null {
  return model ? (effort ? `${model}:${effort}` : model) : null
}

async function status(orca: OrcaWorkerApi): Promise<{ models: OmpModel[]; fusion: FusionState }> {
  const [cfg, acc] = await Promise.all([
    configCatalog(),
    orca.storage.get('acceptance') as Promise<AcceptanceCfg | null>
  ])
  const rv = (configValue(cfg, 'modelRoles') as Record<string, unknown> | undefined) ?? {}
  const planEnabled = configValue(cfg, 'plan.enabled')
  const legacyFrom = configValue(cfg, 'prewalk.from')
  const legacyInto = configValue(cfg, 'prewalk.into')
  const taskPrewalk = configValue(cfg, 'task.prewalk')
  const advisor = configValue(cfg, 'advisor.enabled')
  const fromValue = typeof rv.plan === 'string' && rv.plan ? rv.plan : legacyFrom
  const intoValue = typeof rv.default === 'string' && rv.default ? rv.default : legacyInto
  const sf = split(fromValue), si = split(intoValue)
  const am = split(typeof rv.advisor === 'string' ? rv.advisor : null)
  const ac: AcceptanceCfg = { ocr: acc?.ocr === true, ocrModel: acc?.ocrModel ?? 'gpt-6.2-sol', ocrEffort: acc?.ocrEffort ?? 'high', rulePath: acc?.rulePath ?? '.opencodereview/rule.json', checkCmd: acc?.checkCmd ?? null, autoReview: acc?.autoReview === true, autoRework: acc?.autoRework === true, maxRework: typeof acc?.maxRework === 'number' && acc.maxRework > 0 ? acc.maxRework : 3, autoRoute: acc?.autoRoute === true, planner: typeof acc?.planner === 'string' ? acc.planner : null, executor: typeof acc?.executor === 'string' ? acc.executor : null }
  return { models: modelSnapshot, fusion: { enabled: planEnabled === true, from: sf.model, fromEffort: sf.effort, into: si.model, intoEffort: si.effort, taskPrewalk: taskPrewalk === true, advisor: advisor === true, advisorModel: am.model, advisorEffort: am.effort, ocr: ac.ocr, ocrModel: ac.ocrModel, ocrEffort: ac.ocrEffort, rulePath: ac.rulePath, checkCmd: ac.checkCmd, autoReview: ac.autoReview, autoRework: ac.autoRework, maxRework: ac.maxRework } }
}

export default function activate(orca: OrcaWorkerApi): void {
  installLoopExtension()
  // Warm the catalog off the critical path: fusion.status serves the last
  // snapshot immediately, while models.list waits for a fresh listing.
  void refreshModelCatalog().catch(() => undefined)
  orca.panels.handle('models.list', async (input) => JSON.parse(JSON.stringify(await refreshModelCatalog(input?.force === true))))
  // Propagate failures: a synthetic default fusion with `_err` used to be
  // written into the panel as real data, which stopped the retry loop and
  // pinned wrong settings. The panel now retries a rejected status request.
  orca.panels.handle('fusion.status', async () => JSON.parse(JSON.stringify(await status(orca))))
  orca.panels.handle('session.status', async (input) => sessionStatus(input as { file?: string }))
  orca.panels.handle('session.list', async () => listSessions())
  orca.panels.handle('acceptance.review', async (input) => acceptanceReview(orca, input as { repo?: string; commit?: string; from?: string; to?: string }))
  orca.panels.handle('acceptance.result', async (input) => acceptanceResult(input as { repo?: string }))
  orca.panels.handle('acceptance.stop', async (input) => acceptanceStop(input as { repo?: string; force?: boolean }))
  orca.panels.handle('fusion.set', async ({ enabled, from, fromEffort, into, intoEffort, taskPrewalk, advisor, advisorModel, advisorEffort, ocr, ocrModel, ocrEffort, rulePath, checkCmd, autoReview, autoRework, maxRework }) => {
    const current = (await status(orca)).fusion
    const next = {
      enabled: typeof enabled === 'boolean' ? enabled : current.enabled,
      from: typeof from === 'string' && from ? join2(from, fromEffort === null ? null : fromEffort ?? current.fromEffort) : join2(current.from, fromEffort === null ? null : typeof fromEffort === 'string' ? fromEffort : current.fromEffort),
      into: typeof into === 'string' && into ? join2(into, intoEffort === null ? null : intoEffort ?? current.intoEffort) : join2(current.into, intoEffort === null ? null : typeof intoEffort === 'string' ? intoEffort : current.intoEffort),
      taskPrewalk: typeof taskPrewalk === 'boolean' ? taskPrewalk : current.taskPrewalk,
      advisor: typeof advisor === 'boolean' ? advisor : current.advisor,
      advisorModel: typeof advisorModel === 'string' && advisorModel ? join2(advisorModel, advisorEffort === null ? null : advisorEffort ?? current.advisorEffort) : join2(current.advisorModel, advisorEffort === null ? null : typeof advisorEffort === 'string' ? advisorEffort : current.advisorEffort),
      ocr: typeof ocr === 'boolean' ? ocr : current.ocr,
      ocrModel: typeof ocrModel === 'string' && ocrModel ? ocrModel : current.ocrModel,
      ocrEffort: ocrEffort === null ? null : typeof ocrEffort === 'string' ? ocrEffort : current.ocrEffort,
      rulePath: typeof rulePath === 'string' && rulePath ? rulePath : current.rulePath,
      checkCmd: typeof checkCmd === 'string' ? checkCmd : current.checkCmd,
      autoReview: typeof autoReview === 'boolean' ? autoReview : current.autoReview,
      autoRework: typeof autoRework === 'boolean' ? autoRework : current.autoRework,
      maxRework: typeof maxRework === 'number' && maxRework > 0 ? maxRework : current.maxRework
    }
    // 规划模型=新对话默认+restart;验收模型=modelRoles.advisor(独立第三模型)
    const roles: Record<string, unknown> = (await ompCli<{ value?: Record<string, unknown> }>('config', 'get', 'modelRoles'))?.value ?? {}
    if (next.into) roles.default = next.into
    if (next.from) roles.plan = next.from
    if (next.advisorModel) roles.advisor = next.advisorModel
    const acceptance: AcceptanceCfg = { ocr: next.ocr, ocrModel: next.ocrModel, ocrEffort: next.ocrEffort, rulePath: next.rulePath, checkCmd: next.checkCmd, autoReview: next.autoReview, autoRework: next.autoRework, maxRework: next.maxRework, autoRoute: next.enabled, planner: next.from, executor: next.into }
    await Promise.all([
      ompConfigSet('plan.enabled', next.enabled),
      ompConfigSet('prewalk.enabled', false),
      ompConfigSet('task.prewalk', next.taskPrewalk),
      ompConfigSet('advisor.enabled', next.advisor),
      next.from || next.into || next.advisorModel ? ompConfigSet('modelRoles', roles) : Promise.resolve(),
      orca.storage.set('acceptance', acceptance), writeFileSafe(join(homedir(), '.omp', 'agent', 'orzic-acceptance.json'), JSON.stringify({ ...acceptance }))
    ])
    configCache = null
    const sf = split(next.from), si = split(next.into), sa = split(next.advisorModel)
    return { enabled: next.enabled, from: sf.model, fromEffort: sf.effort, into: si.model, intoEffort: si.effort, taskPrewalk: next.taskPrewalk, advisor: next.advisor, advisorModel: sa.model, advisorEffort: sa.effort, ocr: next.ocr, ocrModel: next.ocrModel, ocrEffort: next.ocrEffort, rulePath: next.rulePath, checkCmd: next.checkCmd, autoReview: next.autoReview, autoRework: next.autoRework, maxRework: next.maxRework }
  })
}
// Live session: newest session .jsonl, model/thinking switch timeline + last tool.
const sessionsRoot = join(homedir(), '.omp', 'agent', 'sessions')
const ACTIVE_WINDOW_MS = 120_000
// The panel is a live workbench, not a history browser. Sessions whose file has
// not changed for this long are treated as finished and hidden; reopening one
// in OMP writes to it again and brings it back.
const RECENT_WINDOW_MS = 15 * 60_000

type SessionFile = { file: string; dir: string; mtime: number }

function listSessions(): { file: string; dir: string; ageMs: number; active: boolean; recent: boolean; title: string | null; cwd: string | null; model: string | null; thinking: string | null; stage: SessionStage; lastTool: string | null; lastToolAt: string | null }[] {
  let dirs: string[]
  try {
    dirs = readdirSync(sessionsRoot)
  } catch (e) {
    // A missing sessions root means "no OMP sessions yet"; any other read
    // failure must reach the panel as an error instead of an empty list, or
    // every row would disappear and look deleted.
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return []
    throw e
  }
  const rows: (SessionFile & { title: string | null; cwd: string | null; status: SessionStatus })[] = []
  for (const dir of dirs) {
    const dirPath = join(sessionsRoot, dir)
    try {
      for (const f of readdirSync(dirPath)) {
        if (!f.endsWith('.jsonl')) continue
        const p = join(dirPath, f)
        try {
          const mtime = statSync(p).mtimeMs
          const meta = sessionMeta(p)
          rows.push({ file: p, dir, mtime, title: meta.title, cwd: meta.cwd, status: sessionStatusFor(p) })
        } catch { /* gone */ }
      }
    } catch { /* dir may be a file or gone */ }
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  const now = Date.now()
  // The worker returns every readable record; `recent` is only a marker. The
  // panel decides what to draw, so an old file is never mistaken for deleted.
  return rows.map((r) => ({
    file: r.file, dir: r.dir, ageMs: now - r.mtime, active: now - r.mtime < ACTIVE_WINDOW_MS,
    recent: now - r.mtime <= RECENT_WINDOW_MS,
    title: r.title, cwd: r.cwd,
    model: r.status.currentModel, thinking: r.status.currentThinking, stage: r.status.stage,
    lastTool: r.status.lastTool, lastToolAt: r.status.lastToolAt,
  }))
}

const metaCache = new Map<string, { title: string | null; cwd: string | null }>()
function sessionMeta(file: string): { title: string | null; cwd: string | null } {
  if (metaCache.has(file)) return metaCache.get(file)!
  const out = { title: null as string | null, cwd: null as string | null }
  try {
    const head = readFileSync(file, 'utf8').slice(0, 8192)
    for (const line of head.split('\n')) {
      if (!line.trim()) continue
      try {
        const d = JSON.parse(line) as { type?: string; title?: string; cwd?: string }
        if (d.type === 'session') {
          if (!out.title && typeof d.title === 'string') out.title = d.title
          if (!out.cwd && typeof d.cwd === 'string') out.cwd = d.cwd
        }
        if (out.title && out.cwd) break
      } catch { /* partial line */ }
    }
  } catch { /* unreadable */ }
  metaCache.set(file, out)
  return out
}

function pickSession(file?: string): { file: string; mtime: number; size: number } | null {
  const rows = listSessions()
  if (!rows.length) return null
  const hit = file ? rows.find((r) => r.file === file) : rows[0]
  if (!hit) return null
  // row has real mtime via ageMs round-trip; stat directly for size+fresh mtime.
  try { const st = statSync(hit.file); return { file: hit.file, mtime: st.mtimeMs, size: st.size } }
  catch { return { file: hit.file, mtime: Date.now() - hit.ageMs, size: 0 } }
}

const statusCache = new Map<string, { mtime: number; size: number; value: SessionStatus }>()
const writeTools: Record<string, true> = { edit: true, write: true, bash: true, ast_edit: true, eval: true, notebook: true }
function emptySessionStatus(): SessionStatus {
  return { file: null, ageMs: null, currentModel: null, currentThinking: null, switches: [], lastTool: null, lastToolAt: null, stage: 'unknown', stageModel: null }
}

// Read one session directly. `listSessions` calls this per row so the panel can
// render every session without N+1 `session.status` round trips; the cache key
// is the file itself, so an unchanged session costs only a stat.
function sessionStatusFor(file: string): SessionStatus {
  const empty = emptySessionStatus()
  let mtime: number
  let size: number
  try { const st = statSync(file); mtime = st.mtimeMs; size = st.size } catch { return empty }
  const cached = statusCache.get(file)
  if (cached && cached.mtime === mtime && cached.size === size) {
    return { ...cached.value, ageMs: Date.now() - mtime }
  }
  empty.file = basename(file)
  empty.ageMs = Date.now() - mtime
  try {
    // Read at most the last 512 KiB — model/tool events we surface are recent.
    let text: string
    if (size > 512 * 1024) {
      const fd = openSync(file, 'r')
      try { const buf = Buffer.alloc(512 * 1024); readSync(fd, buf, 0, 512 * 1024, size - 512 * 1024); text = buf.toString('utf8') } finally { closeSync(fd) }
      text = text.slice(text.indexOf('\n') + 1) // drop the partial first line
    } else {
      text = readFileSync(file, 'utf8')
    }
    const lines = text.split('\n')
    let pendingModel: ModelSwitch | null = null
    for (const line of lines) {
      if (!line.trim()) continue
      let d: Record<string, unknown>
      try { d = JSON.parse(line) } catch { continue }
      const t = d.type as string
      if (t === 'model_change') {
        if (pendingModel) empty.switches.push(pendingModel)
        pendingModel = { at: d.timestamp as string, model: d.model as string, thinking: null }
      } else if (t === 'thinking_level_change' && pendingModel) {
        pendingModel.thinking = (d.thinkingLevel as string) ?? null
      } else if (t === 'message') {
        const msg = (d.message ?? d) as Record<string, unknown>
        const m = (msg.model ?? msg.modelId) as string | undefined
        if (m) empty.currentModel = m
      } else if (t === 'custom' && (d.customType === 'tool_execution_end' || d.customType === 'tool_execution_start')) {
        const data = d.data as Record<string, unknown> | undefined
        const tool = (data?.toolName ?? data?.tool) as string | undefined
        if (tool) {
          empty.lastTool = tool
          empty.lastToolAt = d.timestamp as string
          if (writeTools[tool] === true) empty.stage = 'executing'
        }
      }
    }
    if (pendingModel) empty.switches.push(pendingModel)
    empty.switches.reverse()
    empty.currentThinking = empty.switches[0]?.thinking ?? null
    empty.currentModel = empty.switches[0]?.model ?? empty.currentModel
    empty.stageModel = empty.currentModel
    if (empty.stage !== 'executing') empty.stage = empty.currentModel ? 'planning' : 'unknown'
  } catch { /* unreadable file */ }
  statusCache.set(file, { mtime, size, value: empty })
  // Cache is per-worker; sessions are bounded, so growth is trivial.
  return empty
}

function sessionStatus(input?: { file?: string }): SessionStatus {
  if (input?.file) return sessionStatusFor(input.file)
  const found = pickSession()
  return found ? sessionStatusFor(found.file) : emptySessionStatus()
}
