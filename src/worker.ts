import { execFile } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import type { AcceptanceCfg, FusionState, ModelSwitch, OmpModel, SessionStatus } from './protocol'
import { commandError, ompExecutable } from './cli'
import { acceptanceResult, acceptanceReview, acceptanceStop } from './acceptance'

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

const MODELS_TIMEOUT_MS = 20_000
const MODEL_CATALOG_TTL_MS = 60_000

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

async function ompConfigScalar(key: string): Promise<unknown> {
  return (await ompCli<{ value?: unknown }>('config', 'get', key))?.value
}
async function ompConfigSet(key: string, value: unknown): Promise<void> {
  await ompCli('config', 'set', key, typeof value === 'string' ? value : JSON.stringify(value))
}

let modelCatalog: { at: number; models: OmpModel[] } | null = null
let modelCatalogPending: Promise<OmpModel[]> | null = null

function ompModelCatalog(): Promise<OmpModel[]> {
  if (modelCatalog && Date.now() - modelCatalog.at < MODEL_CATALOG_TTL_MS) return Promise.resolve(modelCatalog.models)
  // One `omp models ls` per worker at a time. Panel requests time out after 28s,
  // but execFile keeps running; without this gate every retry would fork another
  // 20s CLI and they would pile up behind each other.
  if (modelCatalogPending) return modelCatalogPending
  modelCatalogPending = (async (): Promise<OmpModel[]> => {
    try {
      const receipt = await ompCli<{ models?: { provider?: string; id?: string; selector?: string; name?: string; thinking?: unknown }[] }>('models', 'ls')
      const rows = receipt?.models
      if (!Array.isArray(rows)) return []
      const models = rows.flatMap((row) => {
        const id = typeof row.selector === 'string' ? row.selector : row.id
        if (typeof id !== 'string') return []
        return [{ id, name: row.name ?? id, provider: row.provider, thinking: Array.isArray(row.thinking) ? row.thinking.filter((l): l is string => typeof l === 'string') : [] }]
      })
      modelCatalog = { at: Date.now(), models }
      return models
    } catch { return [] } finally { modelCatalogPending = null }
  })()
  return modelCatalogPending
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
  const [models, planEnabled, legacyFrom, legacyInto, taskPrewalk, advisor, roles, acc] = await Promise.all([
    ompModelCatalog(), ompConfigScalar('plan.enabled'), ompConfigScalar('prewalk.from'), ompConfigScalar('prewalk.into'), ompConfigScalar('task.prewalk'), ompConfigScalar('advisor.enabled'),
    ompCli<{ value?: Record<string, unknown> }>('config', 'get', 'modelRoles'),
    orca.storage.get('acceptance') as Promise<AcceptanceCfg | null>
  ])
  const rv = roles?.value ?? {}
  const fromValue = typeof rv.plan === 'string' && rv.plan ? rv.plan : legacyFrom
  const intoValue = typeof rv.default === 'string' && rv.default ? rv.default : legacyInto
  const sf = split(fromValue), si = split(intoValue)
  const am = split(typeof rv.advisor === 'string' ? rv.advisor : null)
  const ac: AcceptanceCfg = { ocr: acc?.ocr === true, ocrModel: acc?.ocrModel ?? 'gpt-6.2-sol', ocrEffort: acc?.ocrEffort ?? 'high', rulePath: acc?.rulePath ?? '.opencodereview/rule.json', checkCmd: acc?.checkCmd ?? null, autoReview: acc?.autoReview === true, autoRework: acc?.autoRework === true, maxRework: typeof acc?.maxRework === 'number' && acc.maxRework > 0 ? acc.maxRework : 3, autoRoute: acc?.autoRoute === true, planner: typeof acc?.planner === 'string' ? acc.planner : null, executor: typeof acc?.executor === 'string' ? acc.executor : null }
  return { models, fusion: { enabled: planEnabled === true, from: sf.model, fromEffort: sf.effort, into: si.model, intoEffort: si.effort, taskPrewalk: taskPrewalk === true, advisor: advisor === true, advisorModel: am.model, advisorEffort: am.effort, ocr: ac.ocr, ocrModel: ac.ocrModel, ocrEffort: ac.ocrEffort, rulePath: ac.rulePath, checkCmd: ac.checkCmd, autoReview: ac.autoReview, autoRework: ac.autoRework, maxRework: ac.maxRework } }
}

export default function activate(orca: OrcaWorkerApi): void {
  installLoopExtension()
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
    const sf = split(next.from), si = split(next.into), sa = split(next.advisorModel)
    return { enabled: next.enabled, from: sf.model, fromEffort: sf.effort, into: si.model, intoEffort: si.effort, taskPrewalk: next.taskPrewalk, advisor: next.advisor, advisorModel: sa.model, advisorEffort: sa.effort, ocr: next.ocr, ocrModel: next.ocrModel, ocrEffort: next.ocrEffort, rulePath: next.rulePath, checkCmd: next.checkCmd, autoReview: next.autoReview, autoRework: next.autoRework, maxRework: next.maxRework }
  })
}
// Live session: newest session .jsonl, model/thinking switch timeline + last tool.
const sessionsRoot = join(homedir(), '.omp', 'agent', 'sessions')
const ACTIVE_WINDOW_MS = 120_000

type SessionFile = { file: string; dir: string; mtime: number }

function listSessions(): { file: string; dir: string; ageMs: number; active: boolean; title: string | null; cwd: string | null }[] {
  try {
    const rows: (SessionFile & { title: string | null; cwd: string | null })[] = []
    for (const dir of readdirSync(sessionsRoot)) {
      const dirPath = join(sessionsRoot, dir)
      try {
        for (const f of readdirSync(dirPath)) {
          if (!f.endsWith('.jsonl')) continue
          const p = join(dirPath, f)
          try {
            const mtime = statSync(p).mtimeMs
            const meta = sessionMeta(p)
            rows.push({ file: p, dir, mtime, title: meta.title, cwd: meta.cwd })
          } catch { /* gone */ }
        }
      } catch { /* dir may be a file or gone */ }
    }
    rows.sort((a, b) => b.mtime - a.mtime)
    const now = Date.now()
    return rows.map((r) => ({ file: r.file, dir: r.dir, ageMs: now - r.mtime, active: now - r.mtime < ACTIVE_WINDOW_MS, title: r.title, cwd: r.cwd }))
  } catch { return [] }
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
const writeTools = new Set(['edit', 'write', 'bash', 'ast_edit', 'eval', 'notebook'])
function sessionStatus(input?: { file?: string }): SessionStatus {
  const found = pickSession(input?.file)
  const empty: SessionStatus = { file: null, ageMs: null, currentModel: null, currentThinking: null, switches: [], lastTool: null, lastToolAt: null, stage: 'unknown', stageModel: null }
  if (!found) return empty
  // Reparse only when the file changed — long sessions were fully re-read and
  // re-parsed on every 3s tick, O(file size) per poll.
  const cached = statusCache.get(found.file)
  if (cached && cached.mtime === found.mtime && cached.size === found.size) {
    return { ...cached.value, ageMs: Date.now() - found.mtime }
  }
  empty.file = basename(found.file)
  empty.ageMs = Date.now() - found.mtime
  try {
    // Read at most the last 512 KiB — model/tool events we surface are recent.
    let text: string
    if (found.size > 512 * 1024) {
      const fd = openSync(found.file, 'r')
      try { const buf = Buffer.alloc(512 * 1024); readSync(fd, buf, 0, 512 * 1024, found.size - 512 * 1024); text = buf.toString('utf8') } finally { closeSync(fd) }
      text = text.slice(text.indexOf('\n') + 1) // drop the partial first line
    } else {
      text = readFileSync(found.file, 'utf8')
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
          if (writeTools.has(tool)) empty.stage = 'executing'
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
  statusCache.set(found.file, { mtime: found.mtime, size: found.size, value: empty })
  // Cache is per-worker; sessions are bounded, so growth is trivial.
  return empty
}
