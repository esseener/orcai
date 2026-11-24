import { atom, Badge, Box, Button, Card, Checkbox, EmptyState, IconButton, Image, Input, KeyValue, on, plugin, read, Row, Separator, set, Stack, Tab, Tabs, Text, Textarea, type PanelContext } from 'orca'
import type { FusionState, OmpModel, SessionStage, SessionStatus } from './protocol'
import { filterModelChoices, isFusionModel } from './orzic-models.mjs'

const status = atom<{ data?: { models?: OmpModel[]; fusion: FusionState }; error?: string } | null>(null)
const modelList = atom<OmpModel[]>([])
type ModelLoadState = 'idle' | 'loading' | 'ready' | 'error'
const modelState = atom<ModelLoadState>('idle')
const modelLoaded = atom(false)
const modelError = atom<string | null>(null)
const session = atom<{ data?: SessionStatus; error?: string } | null>(null)
const sessionList = atom<{ file: string; dir: string; ageMs: number; active: boolean; title: string | null; cwd: string | null }[]>([])
const sessionFile = atom<string | null>(null)
const reviewing = atom(false)
const reviewResult = atom<{ verdict: string; summary: string; findings: { severity: string; file: string; line: number | null; message: string }[] } | null>(null)
const driverState = atom<DriverState | null>(null)
type DriverState = { verdict: string; summary: string; findings: { severity: string; file: string; line: number | null; message: string }[]; at: string | null; round: number | null; consumed: boolean; driverAlive: boolean; driverPid: number | null }

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

// Repo resolution MUST NOT silently fall back to an arbitrary session — a session
// from a DIFFERENT repo would point acceptance.review/stop at the wrong worktree.
// Prefer the picked session's cwd; else the active session; else none.
const currentRepo = (): string | undefined => {
  const rows = read(sessionList)
  const picked = read(sessionFile)
  if (picked) return rows.find((r) => r.file === picked)?.cwd ?? undefined
  return rows.find((r) => r.active)?.cwd ?? undefined
}

async function runReview() {
  const cwd = currentRepo()
  if (!cwd || read(reviewing)) return
  set(reviewing, true); set(reviewResult, null)
  try {
    const r = await plugin.request('acceptance.review', { repo: cwd }, { signal, timeoutMs: 115_000 })
    set(reviewResult, r as { verdict: string; summary: string; findings: { severity: string; file: string; line: number | null; message: string }[] })
  } catch (e) { set(reviewResult, { verdict: 'failed', summary: message(e), findings: [] }) }
  finally { set(reviewing, false) }
}
const busy = atom(false)
const editing = atom<string | null>(null)
const draft = atom<Record<string, { model?: string; effort?: string | null; search?: string }>>({})
const PLUGIN_VERSION = '0.1.16'

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function stageLabel(stage: SessionStage): string {
  return ({ planning: '主脑', executing: '执行', reviewing: '验收', reworking: '返工', idle: '空闲', unknown: '未知' } as Record<SessionStage, string>)[stage]
}
function stageTone(stage: SessionStage): 'accent' | 'success' | 'warning' | 'danger' | 'neutral' {
  return ({ planning: 'accent', executing: 'success', reviewing: 'warning', reworking: 'danger', idle: 'neutral', unknown: 'neutral' } as Record<SessionStage, 'accent' | 'success' | 'warning' | 'danger' | 'neutral'>)[stage]
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

export function setup(ctx: PanelContext) {
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
    const file = read(sessionFile)
    plugin.request('session.status', file ? { file } : {}, { signal: ctx.signal, timeoutMs: 10_000 })
      .then((data) => { if (!ctx.signal.aborted) set(session, { data: data as SessionStatus }) })
      .catch((e) => { if (!ctx.signal.aborted) set(session, { error: message(e) }) })
    plugin.request('session.list', {}, { signal: ctx.signal, timeoutMs: 10_000 })
      .then((rows) => { if (!ctx.signal.aborted) set(sessionList, rows as typeof sessionList extends never ? never : { file: string; dir: string; ageMs: number; active: boolean; title: string | null; cwd: string | null }[]) })
      .catch(() => { /* list is best-effort */ })
    plugin.request('acceptance.result', { repo: currentRepo() }, { signal: ctx.signal, timeoutMs: 8_000 })
      .then((r) => { if (!ctx.signal.aborted) set(driverState, r as DriverState) })
      .catch(() => { /* result is best-effort */ })
  }
  const timer = setInterval(tick, 3000)
  ctx.signal.addEventListener('abort', () => clearInterval(timer))
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

function modelPicker(fid: Fid, title: string, caption: string, currentModel: string | null, currentEffort: string | null, models: OmpModel[]) {
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
      <Row justify="between" gap="sm" align="center">
        <Stack gap="none">
          <Text size="sm" weight="medium">{title}</Text>
          <Text size="xs" muted>{caption}</Text>
        </Stack>
        <Button size="sm" variant="ghost" disabled={read(busy)} onPress={() => set(editing, isEditing ? null : fid)}>
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
        <Row gap="xs" wrap align="center">
          <Text size="xs" muted>思考档</Text>
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
      )}
      {selected && !efforts.length && (
        <Text size="xs" muted>该模型未上报思考档,沿用默认。</Text>
      )}
    </Stack>
  )
}

function fmtAge(ms: number | null): string {
  if (ms == null) return ''
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

function sessionCard(f?: FusionState, driver: DriverState | null = null) {
  const entry = read(session)
  const rows = read(sessionList)
  const picked = read(sessionFile)
  if (entry?.error) return <Card title="OMP 会话"><Text size="sm" tone="warning">{entry.error}</Text></Card>
  const s = entry?.data
  const shown = s?.file
  const current = visibleStage(s, f, driver)
  return (
    <Card title="OMP 会话">
      <Stack gap="sm">
        {rows.length > 1 && (
          <Row gap="xs" wrap>
            {rows.slice(0, 4).map((r) => {
              const label = ((r.title ?? r.dir.split(/[\\/]/).pop() ?? '').replace(/^[\s]+/, '').slice(0, 14)) || '会话'
              const isSel = (picked ?? rows[0].file) === r.file
              return (
                <Button key={r.file} size="xs" variant={isSel ? 'solid' : 'ghost'} onPress={() => set(sessionFile, r.file)}>
                  {r.active ? '● ' : ''}{label} · {fmtAge(r.ageMs)}
                </Button>
              )
            })}
          </Row>
        )}
        {!shown && <EmptyState title="暂无 OMP 会话" description="有会话活动后,这里显示当前阶段、模型和切换记录。" icon="activity" />}
        {shown && (
          <Stack gap="sm">
            <Row justify="between" align="center">
              <KeyValue items={[{ label: '当前模型', value: `${s?.currentModel ?? '未知'}${s?.currentThinking ? ` · ${s.currentThinking}` : ''}` }]} />
              <Badge tone={stageTone(current.stage)}>{stageLabel(current.stage)}{current.model ? ` · ${current.model}` : ''}</Badge>
            </Row>
            {s?.lastTool && <KeyValue items={[{ label: '最近工具', value: `${s.lastTool} · ${s.lastToolAt ? new Date(s.lastToolAt).toLocaleTimeString() : ''}` }]} />}
            {s && s.switches.length > 0 && (
              <Box padding="sm" radius="md" background="muted">
                <Stack gap="xs">
                  <Text size="xs" muted>模型切换历史</Text>
                  {s.switches.slice(0, 8).map((sw, i) => (
                    <Row key={i} justify="between" gap="xs">
                      <Text size="xs" muted>{sw.at ? new Date(sw.at).toLocaleTimeString() : ''}</Text>
                      <Text size="xs">{sw.model}{sw.thinking ? ` · ${sw.thinking}` : ''}</Text>
                    </Row>
                  ))}
                </Stack>
              </Box>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  )
}

	export default function Panel() {
	const entry = read(status)
	const f = entry?.data?.fusion
	const fetched = read(modelList)
	const models = read(modelLoaded) ? fetched : entry?.data?.models ?? []
	return (
		<Box padding="md">
			<Stack gap="md">
				<Row justify="between" align="center" gap="sm">
					<Row align="center" gap="none">
						<Box width={64} shrink={false}><Image src="assets/logo5.png" alt="Orcai" size="full" fit="contain" /></Box>
						<Box width={100} shrink={false} margin="none"><Image src="assets/word.png" alt="" size="xs" fit="contain" /></Box>
					</Row>
					{f && read(activeTab) === 'orzic' && <Badge tone={f.enabled ? 'accent' : 'neutral'}>{f.enabled ? '规划路由开' : '规划路由关'}</Badge>}
				</Row>
				<Tabs label="Orcai 工具" value={read(activeTab)} onChange={(value) => set(activeTab, value)}>
					<Tab value="orzic" label="Orcai">
						<Stack gap="md">
							<Text size="xs" muted>开始任务后由规划模型只读规划；批准计划后恢复执行模型，验收仍在会话外。</Text>
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
								<Card title="规划/执行模型" description="plan 角色 + 默认模型">
									<Stack gap="sm">
										<Checkbox label="启用规划路由" description="任务进入 plan 模式规划，批准后恢复默认模型执行" checked={f.enabled} disabled={read(busy)} onChange={(checked) => patch({ enabled: checked })} />
										{modelPicker('from', '规划模型', 'plan 角色 · 只读规划', f.from, f.fromEffort, models)}
										<Separator />
										{modelPicker('into', '执行模型', '默认模型 · 批准后接手实现', f.into, f.intoEffort, models)}
										<Separator />
										<Checkbox label="子代理同规则" description="内置 task 子代理也启用(task.prewalk)" checked={f.taskPrewalk} disabled={read(busy)} onChange={(checked) => patch({ taskPrewalk: checked })} />
									</Stack>
								</Card>
							)}
							{entry?.data && f && (
								<Card title="验收" description="独立第三模型审查产出">
									<Stack gap="sm">
										<Checkbox label="advisor 验收" description="逐回合审查(advisor)" checked={f.advisor} disabled={read(busy)} onChange={(c) => patch({ advisor: c })} />
										{f.advisor && modelPicker('advisor', '验收模型', '默认跟随规划模型,可独立选', f.advisorModel ?? f.from, f.advisorEffort ?? f.fromEffort, models)}
										<Separator />
										<Checkbox label="ocr 判定式验收" description="rule.json + ocr review,PASS/REWORK 判定" checked={f.ocr} disabled={read(busy)} onChange={(c) => patch({ ocr: c })} />
										{f.ocr && modelPicker('ocr', '审查模型', 'ocr 判定式审查(需 ocr 端点能调到)', f.ocrModel, f.ocrEffort, models)}
										{f.ocr && <Input label="rule.json" value={f.rulePath ?? ''} onChange={(v) => patch({ rulePath: String(v) })} />}
										{f.ocr && <Input label="check 命令(确定性门禁)" value={f.checkCmd ?? ''} onChange={(v) => patch({ checkCmd: String(v) })} />}
										{f.ocr && <Checkbox label="执行完自动验收" description="轮次写完代码后自动跑 ocr review" checked={f.autoReview} disabled={read(busy)} onChange={(c) => patch({ autoReview: c })} />}
										{f.ocr && f.autoReview && <Checkbox label="REWORK 自动返工" description="验收不通过把 findings 注入会话返工(最多 3 轮)" checked={f.autoRework} disabled={read(busy)} onChange={(c) => patch({ autoRework: c })} />}
									{f.ocr && (
										<Row justify="between" align="center">
											<Button size="sm" disabled={read(reviewing) || read(busy)} onPress={() => void runReview()}>
												{read(reviewing) ? '审查中…' : '运行验收'}
											</Button>
											{read(reviewResult) && (
												<Badge tone={({ pass: 'success', rework: 'danger', unreviewed: 'neutral', 'no-repo': 'warning', failed: 'danger' } as Record<string, 'success' | 'danger' | 'neutral' | 'warning'>)[read(reviewResult)!.verdict] ?? 'neutral'}>
													{({ pass: 'PASS', rework: 'REWORK', unreviewed: '未审查', 'no-repo': '无仓库', failed: '失败' } as Record<string, string>)[read(reviewResult)!.verdict] ?? read(reviewResult)!.verdict}
												</Badge>
											)}
										</Row>
									)}
									{read(reviewResult) && (
										<Box padding="sm" radius="md" background="muted">
											<Stack gap="xs">
												<Text size="xs" muted>{read(reviewResult)!.summary}</Text>
												{read(reviewResult)!.findings.slice(0, 5).map((fi, i) => (
													<Text key={i} size="xs" tone={/blocker|critical|high|error/i.test(fi.severity) ? 'danger' : 'warning'}>
														[{fi.severity}] {fi.file}{fi.line != null ? `:${fi.line}` : ''} {fi.message.slice(0, 120)}
													</Text>
												))}
											</Stack>
										</Box>
									)}
									{read(driverState) && (read(driverState)!.driverAlive || read(driverState)!.verdict !== 'none') && (
										<Box padding="sm" radius="md" background="muted">
											<Stack gap="xs">
												<Row justify="between" align="center">
													<Text size="xs" muted>
														自动循环 {read(driverState)!.driverAlive ? `· 运行中${read(driverState)!.driverPid != null ? ` pid:${read(driverState)!.driverPid}` : ''}` : '· 已停'}
														{read(driverState)!.round != null ? ` · 第 ${read(driverState)!.round} 轮` : ''}
														{read(driverState)!.consumed ? ' · 已回喂' : ''}
													</Text>
													<Row gap="xs" align="center">
														<Badge tone={({ pass: 'success', rework: 'danger', unreviewed: 'neutral', 'no-repo': 'warning', failed: 'danger' } as Record<string, 'success' | 'danger' | 'neutral' | 'warning'>)[read(driverState)!.verdict] ?? 'neutral'}>
															{({ pass: 'PASS', rework: 'REWORK', unreviewed: '未审查', 'no-repo': '无仓库', failed: '失败' } as Record<string, string>)[read(driverState)!.verdict] ?? read(driverState)!.verdict}
														</Badge>
														{read(driverState)!.driverAlive && (
															<Row gap="xs" align="center">
																<Button size="sm" variant="ghost" onPress={() => void plugin.request('acceptance.stop', { repo: currentRepo() }, { signal, timeoutMs: 8_000 })}>停止</Button>
																<Button size="sm" variant="ghost" onPress={() => void plugin.request('acceptance.stop', { repo: currentRepo(), force: true }, { signal, timeoutMs: 8_000 })}>强杀</Button>
														</Row>
														)}
													</Row>
												</Row>
												{read(driverState)!.summary ? <Text size="xs" muted>{read(driverState)!.summary}</Text> : null}
											</Stack>
										</Box>
									)}
								</Stack>
							</Card>
							)}
							{sessionCard(f, read(driverState))}
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
