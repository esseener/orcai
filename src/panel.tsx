import { atom, Badge, Box, Button, Card, Checkbox, EmptyState, IconButton, Image, Input, KeyValue, on, plugin, read, Row, Separator, set, Stack, Tab, Tabs, Text, Textarea, type PanelContext } from 'orca'
import type { FusionState, OmpModel, SessionStage, SessionStatus } from './protocol'
import { filterModelChoices, isFusionModel } from './orzic-models.mjs'
import { RECENT_WINDOW_MINUTES, applyHostState, mergeHostOverrides, sessionVisible, sortSessions } from './orzic-session-state.mjs'

const status = atom<{ data?: { models?: OmpModel[]; fusion: FusionState }; error?: string } | null>(null)
const modelList = atom<OmpModel[]>([])
type ModelLoadState = 'idle' | 'loading' | 'ready' | 'error'
const modelState = atom<ModelLoadState>('idle')
const modelLoaded = atom(false)
const modelError = atom<string | null>(null)
type SessionRow = { file: string; dir: string; ageMs: number; active: boolean; recent: boolean; sessionId: string | null; hostState: 'working' | 'blocked' | 'waiting' | 'done' | null; title: string | null; cwd: string | null; model: string | null; thinking: string | null; stage: SessionStage; lastTool: string | null; lastToolAt: string | null }
type ReviewResult = { verdict: string; summary: string; findings: { severity: string; file: string; line: number | null; message: string }[] }
type DriverState = { verdict: string; summary: string; findings: { severity: string; file: string; line: number | null; message: string }[]; at: string | null; round: number | null; consumed: boolean; driverAlive: boolean; driverPid: number | null }
type SessionListState = { state: 'idle' | 'loading' | 'ready' | 'error'; error: string | null }
const sessionList = atom<SessionRow[]>([])
const sessionListState = atom<SessionListState>({ state: 'idle', error: null })
const activeError = atom<string | null>(null)
const reviewResults = atom<Record<string, ReviewResult>>({})
const reviewingRepos = atom<Record<string, number>>({})
const driverStates = atom<Record<string, DriverState>>({})

type Note = { id: string; title: string; body: string; updatedAt: number }
const notes = atom<Note[]>('orzic.notes', [], { persist: 'storage' })
const noteTitle = atom('')
const noteBody = atom('')
const editingNote = atom<string | null>(null)
const noteMessage = atom('')
const activeTab = atom('orzic')

function startNote(note?: Note) {
  set(editingNote, note?.id ?? '')
  set(noteTitle, note?.title ?? '')
  set(noteBody, note?.body ?? '')
  set(noteMessage, '')
}

function cancelNote() {
	set(editingNote, null)
	set(noteTitle, '')
	set(noteBody, '')
	set(noteMessage, '')
}


function saveNote() {
  const body = read(noteBody).trim()
  if (!body) {
    set(noteMessage, '便签内容不能为空。')
    return
  }
  const id = read(editingNote)
	const title = read(noteTitle).trim() || body.split(/\r?\n/, 1)[0].slice(0, 48) || '便签'
  const updatedAt = Date.now()
  set(notes, id
    ? read(notes).map((note) => note.id === id ? { ...note, title, body, updatedAt } : note)
    : [{ id: `${updatedAt}-${Math.random().toString(36).slice(2)}`, title, body, updatedAt }, ...read(notes)])
  set(editingNote, null)
  set(noteTitle, '')
  set(noteBody, '')
	set(noteMessage, '已保存便签。')
}

async function copyNote(note: Note) {
  try {
    await navigator.clipboard.writeText(note.body)
		set(noteMessage, '便签内容已复制；请在 OMP 输入框粘贴后自行提交。')
	} catch {
		set(noteMessage, '无法访问剪贴板。请手动选择并复制便签内容。')
	}
}

let panelAbort: AbortSignal | null = null
const latestReview = new Map<string, number>()
let reviewSeq = 0

// Acceptance is repo-scoped. The active session's repo is the one the
// acceptance controls act on; results stay keyed by repo.
const currentRepo = (): string | undefined => {
  const rows = read(sessionList)
  return (rows.find((row) => row.active) ?? rows[0])?.cwd ?? undefined
}

// Manual review results belong to the repo that produced them. Switching to a
// session in another repo hides them (the UI indexes by currentRepo), and a
// late answer may only replace the latest run for the same repo.
async function runReview() {
  const repo = currentRepo()
  const sig = panelAbort
  if (!repo || !sig || sig.aborted || read(reviewingRepos)[repo]) return
  const seq = ++reviewSeq
  latestReview.set(repo, seq)
  set(reviewingRepos, { ...read(reviewingRepos), [repo]: seq })
  try {
    const r = await plugin.request('acceptance.review', { repo }, { signal: sig, timeoutMs: 115_000 })
    if (!sig.aborted && latestReview.get(repo) === seq) {
      set(reviewResults, { ...read(reviewResults), [repo]: r as ReviewResult })
    }
  } catch (e) {
    if (!sig.aborted && latestReview.get(repo) === seq) {
      set(reviewResults, { ...read(reviewResults), [repo]: { verdict: 'failed', summary: message(e), findings: [] } })
    }
  } finally {
    if (latestReview.get(repo) === seq) {
      const current = read(reviewingRepos)
      if (current[repo] === seq) {
        const next = { ...current }
        delete next[repo]
        set(reviewingRepos, next)
      }
    }
  }
}

async function stopAcceptance(force: boolean) {
  const repo = currentRepo()
  const sig = panelAbort
  if (!repo || !sig || sig.aborted) return
  try { await plugin.request('acceptance.stop', { repo, force }, { signal: sig, timeoutMs: 8_000 }) }
  catch { /* best-effort; the next poll reflects the actual state */ }
}
const busy = atom(false)
const editing = atom<string | null>(null)
const draft = atom<Record<string, { model?: string; effort?: string | null; search?: string }>>({})
const PLUGIN_VERSION = '0.2.0'

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function stageLabel(stage: SessionStage): string {
  return ({ planning: '规划', executing: '执行', reviewing: '验收', reworking: '返工', idle: '空闲', unknown: '未知' } as Record<SessionStage, string>)[stage]
}
function stageTone(stage: SessionStage): 'accent' | 'success' | 'warning' | 'danger' | 'neutral' {
  return ({ planning: 'success', executing: 'success', reviewing: 'warning', reworking: 'danger', idle: 'neutral', unknown: 'neutral' } as Record<SessionStage, 'accent' | 'success' | 'warning' | 'danger' | 'neutral'>)[stage]
}
function visibleStage(s: SessionStatus | undefined, f: FusionState | undefined, driver: DriverState | null): { stage: SessionStage; model: string | null } {
  if (driver?.driverAlive) {
    const stage: SessionStage = driver.verdict === 'rework' && driver.consumed ? 'reworking' : 'reviewing'
    return { stage, model: f?.advisorModel ?? f?.ocrModel ?? null }
  }
  if (!s) return { stage: 'unknown', model: null }
  if (f?.into && s.currentModel === f.into) return { stage: 'executing', model: s.currentModel }
  if (f?.from && s.currentModel === f.from) return { stage: 'planning', model: s.currentModel }
  return { stage: s.stage, model: s.stageModel }
}
function showError(error: unknown) {
  const prev = read(status)
  set(status, prev?.data ? { data: prev.data, error: message(error) } : { error: message(error) })
}

let refreshing = false
async function refresh(signal: AbortSignal) {
  if (refreshing) return
  refreshing = true
  try {
    const result = await plugin.request('fusion.status', {}, { signal, timeoutMs: 28_000 }) as { models?: OmpModel[]; fusion?: FusionState & { _err?: string } }
    // Older workers answered errors with a default fusion + _err instead of
    // rejecting. Treat that as a failed refresh so retries continue instead of
    // pinning the synthetic defaults as real state.
    if (result?.fusion?._err) throw new Error(String(result.fusion._err))
    if (!signal.aborted) set(status, { data: result as { models?: OmpModel[]; fusion: FusionState } })
  } catch (error) { if (!signal.aborted) showError(error) }
  finally { refreshing = false }
}

// Model catalog is a separate, slower read (`omp models ls`, ~5.6s on a cold
// CLI). fusion.status returns the last disk snapshot immediately; this fills
// the pickers when the fresh listing lands.
let fetchingModels = false
async function fetchModels(signal: AbortSignal, force = false) {
  if (fetchingModels) return
  fetchingModels = true
  set(modelState, 'loading')
  try {
    const list = await plugin.request('models.list', { force }, { signal, timeoutMs: 28_000 })
    // An empty array is a successful listing, not a failure: mark it ready so
    // the retry loop stops and pickers stop asking.
    if (!signal.aborted) { set(modelList, list as OmpModel[]); set(modelError, null); set(modelState, 'ready'); set(modelLoaded, true) }
  } catch (error) {
    if (!signal.aborted) { set(modelError, message(error)); set(modelState, 'error') }
  } finally { fetchingModels = false }
}

function patch(patch: { enabled?: boolean; from?: string; fromEffort?: string | null; into?: string; intoEffort?: string | null; taskPrewalk?: boolean; advisor?: boolean; advisorModel?: string; advisorEffort?: string | null; ocr?: boolean; ocrModel?: string; ocrEffort?: string | null; rulePath?: string; checkCmd?: string; autoReview?: boolean; autoRework?: boolean; maxRework?: number }) {
  const entry = read(status)
  if (!entry?.data || read(busy)) return
  set(busy, true)
  const previous = entry.data.fusion
  set(status, { data: { ...entry.data, fusion: { ...previous, ...patch } } })
  void plugin.request('fusion.set', patch, { signal, timeoutMs: 15_000 })
    .then((next) => { set(draft, {}); if (!signal.aborted) set(status, { data: { ...entry.data, fusion: next } }) })
    .catch((error) => { set(draft, {}); if (!signal.aborted) set(status, { data: { ...entry.data, fusion: previous }, error: message(error) }) })
    .finally(() => set(busy, false))
}

let listBusy = false
let listQueued = false
type HostState = 'working' | 'blocked' | 'waiting' | 'done'
const hostOverrides = new Map<string, HostState>()
let acceptanceAbort: AbortController | null = null
let acceptanceRepo: string | null = null

async function loadSessionList(sig: AbortSignal, force = false): Promise<SessionRow[] | null> {
  if (listBusy) {
    if (force) listQueued = true
    return null
  }
  listBusy = true
  if (read(sessionListState).state === 'idle') set(sessionListState, { state: 'loading', error: null })
  try {
    const response = await plugin.request('session.list', {}, { signal: sig, timeoutMs: 10_000 }) as { sessions: SessionRow[]; activeError: string | null }
    if (sig.aborted) return null
    // A snapshot requested before an event must not undo the event.
    const rows = mergeHostOverrides(response.sessions, hostOverrides)
    set(sessionList, rows)
    set(activeError, response.activeError)
    set(sessionListState, { state: 'ready', error: null })
    return rows
  } catch (e) {
    // Keep the last rows: a transient read failure is not a deleted session.
    if (!sig.aborted) set(sessionListState, { state: 'error', error: message(e) })
    return null
  } finally {
    listBusy = false
    if (listQueued && !sig.aborted) {
      listQueued = false
      void loadSessionList(sig)
    }
  }
}

// Only one acceptance poll may be in flight. When the active repo changes,
// abort the old request and start the new one; results stay keyed by repo.
async function loadAcceptance(sig: AbortSignal) {
  const repo = currentRepo()
  if (!repo) {
    acceptanceAbort?.abort()
    acceptanceRepo = null
    return
  }
  if (acceptanceAbort && acceptanceRepo === repo) return
  acceptanceAbort?.abort()
  const controller = new AbortController()
  const forwardAbort = () => controller.abort()
  sig.addEventListener('abort', forwardAbort, { once: true })
  acceptanceAbort = controller
  acceptanceRepo = repo
  try {
    const result = await plugin.request('acceptance.result', { repo }, { signal: controller.signal, timeoutMs: 8_000 })
    if (!controller.signal.aborted && !sig.aborted && currentRepo() === repo) {
      set(driverStates, { ...read(driverStates), [repo]: result as DriverState })
    }
  } catch { /* best-effort; the next poll retries */ }
  finally {
    sig.removeEventListener('abort', forwardAbort)
    if (acceptanceAbort === controller) { acceptanceAbort = null; acceptanceRepo = null }
  }
}

export function setup(ctx: PanelContext) {
  panelAbort = ctx.signal
  listBusy = false
  listQueued = false
  hostOverrides.clear()
  // Status events update the matching row immediately; the 3s poll remains as
  // a calibration for new/removed sessions and missed events.
  const agentsSub = on('agent.status.changed', (payload) => {
    if (ctx.signal.aborted) return
    if (payload.sessionId) {
      hostOverrides.set(payload.sessionId, payload.state)
      set(sessionList, read(sessionList).map((row) => applyHostState(row, payload.sessionId ?? null, payload.state)))
    }
    void loadSessionList(ctx.signal, true)
  })
  void refresh(ctx.signal)
  void fetchModels(ctx.signal)
  // `fusion.status` can fail transiently (worker restart, IPC drop) or keep
  // returning an error. Retry while the panel has no usable payload OR carries
  // an error; back off 5s→60s so a hard failure does not hammer the OMP CLI,
  // and reset the backoff once a clean payload lands.
  let statusRetryDelay = 5_000
  let statusRetryAt = Date.now() + statusRetryDelay
  let modelsRetryAt = Date.now() + 15_000
  const tick = () => {
    if (ctx.signal.aborted) return
    const entry = read(status)
    if (entry?.data && !entry.error) {
      statusRetryDelay = 5_000
      statusRetryAt = 0
    } else if (Date.now() >= statusRetryAt) {
      statusRetryAt = Date.now() + statusRetryDelay
      statusRetryDelay = Math.min(statusRetryDelay * 2, 60_000)
      void refresh(ctx.signal)
    }
    // Retry only while no listing has succeeded (idle/loading/error). Force it:
    // a failed forced refresh must not be "recovered" from the still-warm empty
    // cache, which would clear the error without running the CLI.
    if (read(modelState) !== 'ready' && Date.now() >= modelsRetryAt) {
      modelsRetryAt = Date.now() + 15_000
      void fetchModels(ctx.signal, true)
    }
    void loadSessionList(ctx.signal)
    void loadAcceptance(ctx.signal)
  }
  tick()
  const timer = setInterval(tick, 3000)
  const stop = () => {
    if (panelAbort !== ctx.signal) return
    clearInterval(timer)
    agentsSub.dispose()
    panelAbort = null
    acceptanceAbort?.abort()
    acceptanceRepo = null
    listBusy = false
    listQueued = false
    hostOverrides.clear()
  }
  ctx.signal.addEventListener('abort', stop, { once: true })
}

const signal = new AbortController().signal

function modelSearch(fid: string, q: string) {
  set(draft, { ...read(draft), [fid]: { ...read(draft)[fid], search: q } })
}

const fidKeys = { from: ['from', 'fromEffort'], into: ['into', 'intoEffort'], advisor: ['advisorModel', 'advisorEffort'], ocr: ['ocrModel', 'ocrEffort'] } as const
type Fid = keyof typeof fidKeys

function pickModel(fid: Fid, id: string) {
  const d = read(draft)[fid] ?? {}
  set(draft, { ...read(draft), [fid]: { ...d, model: id, effort: null } })
  set(editing, null)
  const [modelKey, effortKey] = fidKeys[fid]
  patch({ [modelKey]: id, [effortKey]: null })
}

function modelLabel(model: OmpModel | undefined, fallback: string): string {
  if (!model) return fallback
  const supplier = model.provider || model.id.split('/')[0]
  return supplier ? `${supplier} · ${model.name}` : model.name
}

function modelEmptyLabel(): string {
  const state = read(modelState)
  if (state === 'ready') return '目录中没有可用模型'
  if (state === 'error') return '模型目录不可用'
  return '模型目录加载中…'
}

function modelPicker(fid: Fid, title: string, caption: string, currentModel: string | null, currentEffort: string | null, models: OmpModel[], role?: string) {
  const d = read(draft)[fid] ?? {}
  const isEditing = read(editing) === fid
  // Devin's ~1000 `fusion-*` combos stay out of the picker: they are one-off
  // driver/sidekick compositions and they crowd out the plain models a user
  // actually searches for (e.g. `devin/swe-2`).
  const filtered = filterModelChoices(models, d.search ?? '')
  const totalFusion = models.reduce((n, m) => n + (isFusionModel(m) ? 1 : 0), 0)
  const selected = d.model ?? currentModel
  const selectedModel = models.find((m) => m.id === selected)
  const efforts = selectedModel?.thinking ?? []
  const effort = d.effort ?? currentEffort

  return (
    <Stack gap="xs">
      <Row align="center" gap="xs">
        <Text size="sm" weight="medium">{title}</Text>
        {role && <Badge tone="neutral">{role}</Badge>}
      </Row>
      <Text size="xs" muted>{caption}</Text>
      <Row justify="start">
        <Button size="sm" variant="ghost" disabled={read(busy)} tooltip={selected ? modelLabel(selectedModel, selected) : undefined} onPress={() => set(editing, isEditing ? null : fid)}>
          {selected ? modelLabel(selectedModel, selected) : '选择模型'}
        </Button>
      </Row>
      {isEditing && (
        <Box padding="xs" radius="md" background="card" border>
          <Stack gap="xs">
            <Input label="搜索" labelHidden value={d.search ?? ''} placeholder="搜索模型" disabled={read(busy)} onChange={(v) => modelSearch(fid, v)} />
            {totalFusion > 0 && (
              <Text size="xs" muted>{`已隐藏 ${totalFusion} 个 Devin fusion 合成模型`}</Text>
            )}
            <Box maxHeight={180} scroll="y">
              <Stack gap="none" align="stretch">
                {filtered.map((m) => (
                  <Button key={m.id} variant="ghost" size="sm" disabled={read(busy)} onPress={() => pickModel(fid, m.id)}>
                    {modelLabel(m, m.name)}
                  </Button>
                ))}
                {!filtered.length && <Text size="xs" muted>{models.length ? '无匹配模型' : modelEmptyLabel()}</Text>}
              </Stack>
            </Box>
          </Stack>
        </Box>
      )}
      {selected && efforts.length > 0 && (
        <Stack gap="xs">
          <Text size="xs" muted>思考档</Text>
          <Row gap="xs" wrap>
            {['', ...efforts].map((l) => {
              const active = (effort ?? '') === l
              return (
                <Button key={l || 'default'} size="xs" variant={active ? 'solid' : 'ghost'} tone={active ? 'accent' : 'neutral'} disabled={read(busy)} onPress={() => {
                  const d2 = read(draft)[fid] ?? {}
                  set(draft, { ...read(draft), [fid]: { ...d2, effort: l || null } })
                  patch({ [fidKeys[fid][1]]: l || null })
                }}>{l || '默认'}</Button>
              )
            })}
          </Row>
        </Stack>
      )}
      {selected && !efforts.length && (
        <Text size="xs" muted>该模型未上报思考档,沿用默认。</Text>
      )}
    </Stack>
  )
}

function sessionTitle(row: SessionRow): string {
  const title = (row.title ?? '').trim()
  if (title) return title
  return row.dir.split(/[\\/]/).filter(Boolean).pop() || '会话'
}

function projectName(cwd: string | null): string {
  return cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? '' : ''
}

function sessionBadge(row: SessionRow): { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' } {
  if (row.hostState === 'working') return { label: stageLabel(row.stage), tone: stageTone(row.stage) }
  if (row.hostState === 'blocked') return { label: '阻塞', tone: 'danger' }
  if (row.hostState === 'waiting') return { label: '等待', tone: 'warning' }
  if (row.hostState === 'done') return { label: '已结束', tone: 'neutral' }
  return { label: '最近', tone: 'neutral' }
}

function sessionsCard(rows: SessionRow[], listState: SessionListState) {
  const visible = sortSessions(rows.filter(sessionVisible))
  const active = visible.filter((row) => row.active).length
  const description = visible.length
    ? `${visible.length} 个会话${active ? ` · ${active} 个活跃` : ''} · 最近 ${RECENT_WINDOW_MINUTES} 分钟`
    : listState.state === 'ready' ? `最近 ${RECENT_WINDOW_MINUTES} 分钟没有进行中的会话` : 'OMP 会话'
  return (
    <Card title="OMP 会话" description={description}>
      <Stack gap="sm">
        {read(activeError) && (
          <Text size="xs" tone="warning">实时活跃状态不可用：{read(activeError)}（仅显示近期记录）</Text>
        )}
        {listState.state === 'error' && (
          <Text size="xs" tone="warning">列表刷新失败：{listState.error}（保留上次结果，下个周期重试）</Text>
        )}
        {visible.length === 0 && listState.state === 'ready' && (
          <EmptyState title="暂无进行中的会话" description="在 OMP 里继续一个会话后，它会自动出现在这里。" icon="activity" />
        )}
        {visible.length === 0 && (listState.state === 'idle' || listState.state === 'loading') && (
          <Text size="xs" muted>正在读取会话…</Text>
        )}
        {visible.map((row, index) => {
          const badge = sessionBadge(row)
          const meta = [
            row.active ? '活跃' : null,
            projectName(row.cwd),
            row.lastTool ? `工具 ${row.lastTool}${row.lastToolAt ? ` · ${new Date(row.lastToolAt).toLocaleTimeString()}` : ''}` : null,
          ].filter(Boolean).join(' · ')
          return (
            <Stack key={row.file} gap="sm">
              {index > 0 && <Separator />}
              <Box paddingY="xs">
                <Stack gap="sm">
                  <Row justify="between" align="start" gap="sm">
                    <Text size="sm" weight="medium">{sessionTitle(row)}</Text>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </Row>
                  <Text size="sm">{row.model ?? '未知'}{row.thinking ? ` · ${row.thinking}` : ''}</Text>
                  {meta && <Text size="xs" muted>{meta}</Text>}
                </Stack>
              </Box>
            </Stack>
          )
        })}
      </Stack>
    </Card>
  )
}

	export default function Panel() {
	const entry = read(status)
	const f = entry?.data?.fusion
	const fetched = read(modelList)
	const models = read(modelLoaded) ? fetched : entry?.data?.models ?? []
	const repo = currentRepo()
	const review = repo ? read(reviewResults)[repo] ?? null : null
	const reviewRunning = repo ? Boolean(read(reviewingRepos)[repo]) : false
	const driver = repo ? read(driverStates)[repo] ?? null : null
	return (
		<Box padding="md">
			<Stack gap="md">
				<Row align="center" gap="none">
					<Box width={64} shrink={false}><Image src="assets/logo5.png" alt="Orcai" size="full" fit="contain" /></Box>
					<Box width={100} shrink={false} margin="none"><Image src="assets/word.png" alt="" size="xs" fit="contain" /></Box>
				</Row>
				<Tabs label="Orcai 功能模块" value={read(activeTab)} onChange={(value) => set(activeTab, value)}>
					<Tab value="orzic" label="Orzic">
						<Stack gap="md">
							<Row justify="between" align="center" gap="sm">
								<Text size="sm" weight="medium">规划 → 执行 → 验收</Text>
								{f && <Badge tone={f.enabled ? 'accent' : 'neutral'}>{f.enabled ? '规划路由开' : '规划路由关'}</Badge>}
							</Row>
							<Text size="xs" muted>规划阶段只读，写完 PLAN.md 后切执行模型</Text>
							{entry?.error && <Text size="sm" tone="warning">{entry.error}</Text>}
							{read(modelError) && (
								<Row justify="between" align="center" gap="sm">
									<Text size="sm" tone="warning">
										{models.length ? `模型目录刷新失败，使用缓存：${read(modelError)}` : `模型目录加载失败：${read(modelError)}`}
									</Text>
									<Button size="sm" variant="ghost" onPress={() => void fetchModels(signal, true)}>重试</Button>
								</Row>
							)}
							{read(modelState) === 'ready' && !models.length && (
								<Row justify="between" align="center" gap="sm">
									<Text size="sm" muted>模型目录为空；新增模型后可刷新。</Text>
									<Button size="sm" variant="ghost" onPress={() => void fetchModels(signal, true)}>刷新</Button>
								</Row>
							)}
							{!entry?.data && !entry?.error && (
								<Card title="正在读取配置" description="plan 角色 + 默认模型">
									<Text size="sm" muted>正在从 OMP 读取模型角色；模型目录会在后台单独加载。</Text>
								</Card>
							)}
							{entry?.data && f && (
								<Card title="路由">
									<Stack gap="sm">
										<Checkbox label="启用规划路由" description="新任务先由规划模型只读规划" checked={f.enabled} disabled={read(busy)} onChange={(checked) => patch({ enabled: checked })} />
										<Checkbox label="子代理启用 prewalk" description="内置 task 子代理按 OMP prewalk 切执行模型" checked={f.taskPrewalk} disabled={read(busy)} onChange={(checked) => patch({ taskPrewalk: checked })} />
									</Stack>
								</Card>
							)}
							{entry?.data && f && (
								<Card title="模型" description="规划用 plan，执行用 default">
									<Stack gap="sm">
										<Box padding="sm" radius="md" background="muted">
											{modelPicker('from', '规划模型', '只读规划', f.from, f.fromEffort, models, 'plan')}
										</Box>
										<Box padding="sm" radius="md" background="muted">
											{modelPicker('into', '执行模型', '接手实现', f.into, f.intoEffort, models, 'default')}
										</Box>
									</Stack>
								</Card>
							)}
							{entry?.data && f && (
								<Card title="验收" description="独立模型审查产出，可自动返工">
									<Stack gap="sm">
										<Box padding="sm" radius="md" background="muted">
											<Stack gap="sm">
												<Checkbox label="advisor 验收" description="逐回合审查（advisor 模型）" checked={f.advisor} disabled={read(busy)} onChange={(c) => patch({ advisor: c })} />
												{f.advisor && modelPicker('advisor', '验收模型', '默认跟随规划模型', f.advisorModel ?? f.from, f.advisorEffort ?? f.fromEffort, models, 'advisor')}
											</Stack>
										</Box>
										<Box padding="sm" radius="md" background="muted">
											<Stack gap="sm">
												<Checkbox label="ocr 判定式验收" description="按 rule.json 与 findings 判定 PASS / REWORK" checked={f.ocr} disabled={read(busy)} onChange={(c) => patch({ ocr: c })} />
												{f.ocr && modelPicker('ocr', '审查模型', '需要 ocr 端点可用', f.ocrModel, f.ocrEffort, models, 'ocr')}
												{f.ocr && <Input label="rule.json" value={f.rulePath ?? ''} onChange={(v) => patch({ rulePath: String(v) })} />}
												{f.ocr && <Input label="check 命令（确定性门禁）" value={f.checkCmd ?? ''} onChange={(v) => patch({ checkCmd: String(v) })} />}
												{f.ocr && <Checkbox label="执行完自动验收" description="写完代码的轮次自动跑 ocr review" checked={f.autoReview} disabled={read(busy)} onChange={(c) => patch({ autoReview: c })} />}
												{f.ocr && f.autoReview && <Checkbox label="REWORK 自动返工" description="把 findings 注入会话返工（最多 3 轮）" checked={f.autoRework} disabled={read(busy)} onChange={(c) => patch({ autoRework: c })} />}
											</Stack>
										</Box>
										{f.ocr && <Separator />}
										{f.ocr && (
											<Row justify="between" align="center">
												<Button size="sm" disabled={!repo || reviewRunning || read(busy)} onPress={() => void runReview()}>
													{reviewRunning ? '审查中…' : '运行验收'}
												</Button>
												{review && (
													<Badge tone={({ pass: 'success', rework: 'danger', unreviewed: 'neutral', 'no-repo': 'warning', failed: 'danger' } as Record<string, 'success' | 'danger' | 'neutral' | 'warning'>)[review!.verdict] ?? 'neutral'}>
														{({ pass: 'PASS', rework: 'REWORK', unreviewed: '未审查', 'no-repo': '无仓库', failed: '失败' } as Record<string, string>)[review!.verdict] ?? review!.verdict}
													</Badge>
												)}
											</Row>
										)}
									{review && (
										<Box padding="sm" radius="md" background="muted">
											<Stack gap="xs">
												<Text size="xs" muted>{review!.summary}</Text>
												{review!.findings.slice(0, 5).map((fi, i) => (
													<Text key={i} size="xs" tone={/blocker|critical|high|error/i.test(fi.severity) ? 'danger' : 'warning'}>
														[{fi.severity}] {fi.file}{fi.line != null ? `:${fi.line}` : ''} {fi.message.slice(0, 120)}
													</Text>
												))}
											</Stack>
										</Box>
									)}
									{driver && (driver!.driverAlive || driver!.verdict !== 'none') && (
										<Box padding="sm" radius="md" background="muted">
											<Stack gap="xs">
												<Row justify="between" align="center">
													<Text size="xs" muted>
														自动循环 {driver!.driverAlive ? `· 运行中${driver!.driverPid != null ? ` pid:${driver!.driverPid}` : ''}` : '· 已停'}
														{driver!.round != null ? ` · 第 ${driver!.round} 轮` : ''}
														{driver!.consumed ? ' · 已回喂' : ''}
													</Text>
													<Row gap="xs" align="center">
														<Badge tone={({ pass: 'success', rework: 'danger', unreviewed: 'neutral', 'no-repo': 'warning', failed: 'danger' } as Record<string, 'success' | 'danger' | 'neutral' | 'warning'>)[driver!.verdict] ?? 'neutral'}>
															{({ pass: 'PASS', rework: 'REWORK', unreviewed: '未审查', 'no-repo': '无仓库', failed: '失败' } as Record<string, string>)[driver!.verdict] ?? driver!.verdict}
														</Badge>
														{driver!.driverAlive && (
															<Row gap="xs" align="center">
																<Button size="sm" variant="ghost" onPress={() => void stopAcceptance(false)}>停止</Button>
																<Button size="sm" variant="ghost" onPress={() => void stopAcceptance(true)}>强杀</Button>
															</Row>
														)}
													</Row>
												</Row>
												{driver!.summary ? <Text size="xs" muted>{driver!.summary}</Text> : null}
											</Stack>
										</Box>
									)}
								</Stack>
							</Card>
							)}
							{sessionsCard(read(sessionList), read(sessionListState))}
						</Stack>
					</Tab>
					<Tab value="notes" label="便签">
						<Stack gap="sm">
							<Row justify="between" align="center"><Text size="sm" weight="medium">灵感便签</Text><Button size="sm" onPress={() => startNote()}>新建便签</Button></Row>
							<Text size="xs" muted>点击复制后粘贴到 OMP 输入框；不会自动发送。</Text>
							{read(noteMessage) && <Text size="xs" muted>{read(noteMessage)}</Text>}
							{read(editingNote) !== null && <Card title={read(editingNote) ? '编辑便签' : '新建便签'}><Stack gap="sm"><Input label="标题" value={read(noteTitle)} maxLength={80} placeholder="可留空，自动使用首行" onChange={(value) => set(noteTitle, value)} /><Textarea label="内容" value={read(noteBody)} rows={6} maxLength={12000} placeholder="记录稍后要补充给 Agent 的想法" onChange={(value) => set(noteBody, value)} /><Row gap="sm"><Button size="sm" onPress={saveNote}>保存</Button><Button size="sm" variant="ghost" onPress={cancelNote}>取消</Button></Row></Stack></Card>}
							{read(notes).length === 0 ? <EmptyState title="还没有便签" description="记录运行时想到的补充要求。" icon="file" /> : read(notes).map((note) => <Card key={note.id} title={note.title} description={new Date(note.updatedAt).toLocaleString()}><Stack gap="sm"><Text size="sm">{note.body}</Text><Row gap="xs" wrap><Button size="sm" icon="copy" onPress={() => void copyNote(note)}>复制</Button><Button size="sm" variant="ghost" onPress={() => startNote(note)}>编辑</Button><IconButton icon="delete" label="删除便签" variant="ghost" onPress={() => { set(notes, read(notes).filter((item) => item.id !== note.id)); set(noteMessage, '已删除便签。'); }} /></Row></Stack></Card>)}
						</Stack>
					</Tab>
				</Tabs>
				<Text size="xs" muted>Orcai v{PLUGIN_VERSION}</Text>
			</Stack>
		</Box>
	)
}
