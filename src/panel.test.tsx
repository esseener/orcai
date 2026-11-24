// Model picker regression tests. The devin provider ships ~1000 `fusion-*`
// combos next to its plain models, and they used to swallow every search:
// `swe2` matched ~285 fusion rows, all of them drawn before the real
// `devin/swe-2` fell past the 200-row cap. Run: orca plugin test .
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mount, mockHost, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { OmpModel, SessionStatus } from './protocol'

const fusionRow = (i: number): OmpModel => ({
  id: `devin/fusion-claude-opus-5-high-sidekick-swe-2-${i}`,
  name: `fusion-claude-opus-5-high-sidekick-swe-2-${i}`,
  provider: 'devin',
  thinking: [],
})

const current = 'a6api · GPT-6.2 Astra'
const models: OmpModel[] = [
  { id: 'a6api/gpt-6.2-astra', name: 'GPT-6.2 Astra', provider: 'a6api', thinking: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ...Array.from({ length: 285 }, (_, i) => fusionRow(i)),
  { id: 'devin/swe-2', name: 'SWE-2', provider: 'devin', thinking: ['high'] },
  { id: 'devin/swe-2-fast', name: 'SWE-2 Fast', provider: 'devin', thinking: [] },
  { id: 'magpie/智能钣金', name: '智能钣金拆解', provider: 'magpie', thinking: [] },
]

const fusion = {
  enabled: false, from: 'a6api/gpt-6.2-astra', fromEffort: null,
  // Both rows use the same model on purpose: the thinking test then sees every
  // level twice and must prove the planner's row is the one highlighted.
  into: 'a6api/gpt-6.2-astra', intoEffort: null,
  taskPrewalk: false, advisor: false, advisorModel: null, advisorEffort: null,
  ocr: false, ocrModel: null, ocrEffort: null, rulePath: null, checkCmd: null,
  autoReview: false, autoRework: false, maxRework: 3,
}

const requests = {
  'fusion.status': { models, fusion },
  'models.list': models,
  'session.status': {} as never,
  'session.list': [],
  'acceptance.result': {} as never,
}

let mounted: TestPanel | undefined

function requestFile(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('file' in input)) return undefined
  return typeof input.file === 'string' ? input.file : undefined
}

async function openPicker() {
  mounted = await mount(panel, { host: mockHost({ requests }) })
  assert.deepEqual(mounted.errors, [])
  // The panel opens on 会话; model settings live under the Orzic tab.
  await mounted.select({ type: 'Tabs' }, 'orzic')
  await mounted.press({ text: current })
  return mounted
}

// Model rows only: the picker's own button repeats the current selection.
const rows = (test: TestPanel) =>
  test.findAll({ type: 'Button' }).map((el) => el.text).filter((text) => text.includes(' · ') && text !== current)

afterEach(async () => {
  await mounted?.unmount()
  mounted = undefined
})

test('searching swe2 lists the real SWE-2 models and no fusion combo', async () => {
  const test = await openPicker()
  await test.type({ label: '搜索' }, 'swe2')
  assert.equal(test.valueOf({ label: '搜索' }), 'swe2')
  assert.deepEqual(rows(test), ['devin · SWE-2', 'devin · SWE-2 Fast'])
  assert.equal(test.find({ text: '已隐藏 285 个 Devin fusion 合成模型' })?.text, '已隐藏 285 个 Devin fusion 合成模型')
})

test('an unfiltered list never draws a fusion combo', async () => {
  const test = await openPicker()
  const listed = rows(test)
  assert.deepEqual(listed, ['devin · SWE-2', 'devin · SWE-2 Fast', 'magpie · 智能钣金拆解'])
})

test('Chinese model names stay searchable', async () => {
  const test = await openPicker()
  await test.type({ label: '搜索' }, '钣金')
  assert.deepEqual(rows(test), ['magpie · 智能钣金拆解'])
})

test('picking a filtered model writes it as the plan model', async () => {
  const test = await openPicker()
  await test.type({ label: '搜索' }, 'swe2', { replace: true })
  await test.press({ text: 'devin · SWE-2' })
  const writes = (test.host.callsOf('plugin.request') as { name: string; input: unknown }[])
    .filter((call) => call.name === 'fusion.set')
    .map((call) => call.input)
  assert.deepEqual(writes, [{ from: 'devin/swe-2', fromEffort: null }])
})

test('Orcai exposes Orzic, 会话 and 便签 as separate modules', async () => {
  mounted = await mount(panel, { host: mockHost({ requests }) })
  assert.deepEqual(mounted.errors, [])
  // The panel is the Orcai container; each tab is one module.
  assert.deepEqual(mounted.findAll({ type: 'Tab' }).map((tab) => tab.text), ['Orzic', '会话', '便签'])
  await mounted.select({ type: 'Tabs' }, 'orzic')
  const images = (alt: string) => mounted!.findAll({ type: 'Image' }).filter((image) => image.props.alt === alt)
  const orzicTab = mounted.find({ type: 'Tab', text: 'Orzic' })
  const routingBadge = mounted.find({ text: '规划路由关' })
  const orzicMark = images('Orzic')[0]
  const wordmark = images('Orcai')[0]
  assert.ok(orzicTab)
  assert.ok(routingBadge)
  assert.ok(orzicMark)
  assert.ok(wordmark)
  // The Orcai wordmark is global; the Orzic mark and routing badge sit inside the Orzic Tab subtree.
  assert.equal(images('Orcai').length, 1)
  assert.equal(images('Orzic').length, 1)
  assert.ok(!wordmark.path.startsWith(`${orzicTab.path}/`), `wordmark ${wordmark.path} should be outside ${orzicTab.path}`)
  assert.ok(orzicMark.path.startsWith(`${orzicTab.path}/`), `Orzic mark ${orzicMark.path} should be inside ${orzicTab.path}`)
  assert.ok(routingBadge.path.startsWith(`${orzicTab.path}/`), `routing badge ${routingBadge.path} should be inside ${orzicTab.path}`)
  await mounted.select({ type: 'Tabs' }, 'notes')
  assert.equal(mounted.find({ type: 'EmptyState', label: '还没有便签' })?.label, '还没有便签')
  assert.equal(images('Orcai').length, 1)
  assert.equal(images('Orzic').length, 0)
  assert.equal(mounted.find({ text: '规划路由关' }), null)
})

test('a pinned session stays selected and can be changed by click', async () => {
  const alphaFile = 'C:\\sessions\\alpha.jsonl'
  const betaFile = 'C:\\sessions\\beta.jsonl'
  const rows = [
    { file: alphaFile, dir: 'sessions', ageMs: 1_000, active: true, title: 'Alpha', cwd: 'C:\\work\\alpha' },
    { file: betaFile, dir: 'sessions', ageMs: 2_000, active: false, title: 'Beta', cwd: 'C:\\work\\beta' },
  ]
  const statusFor = (file?: string): SessionStatus => {
    const name = (file ?? alphaFile).split(/[\\/]/).pop()!
    const alpha = name.startsWith('alpha')
    return {
      file: name, ageMs: 1_000, currentModel: alpha ? 'model-alpha' : 'model-beta', currentThinking: null,
      switches: [], lastTool: null, lastToolAt: null, stage: 'executing', stageModel: null,
    }
  }
  mounted = await mount(panel, {
    host: mockHost({
      storage: { 'orzic.sessionFile': betaFile },
      requests: {
        ...requests,
        'session.list': rows,
        'session.status': (input) => statusFor(requestFile(input)),
      },
    }),
  })
  assert.deepEqual(mounted.errors, [])
  await mounted.select({ type: 'Tabs' }, 'sessions')
  await mounted.settled()
  const currentRow = () => mounted!.findAll({ type: 'ListItem' }).filter((row) => row.props.current === true).map((row) => row.label)
  // Alpha is the newest/active session, but the persisted pin keeps Beta in view.
  assert.deepEqual(currentRow(), ['Beta'])
  assert.match(mounted.find({ text: /model-beta/ })?.text ?? '', /model-beta/)
  const statusCalls = (mounted.host.callsOf('plugin.request') as { name: string; input: unknown }[])
    .filter((call) => call.name === 'session.status')
  assert.ok(statusCalls.some((call) => requestFile(call.input) === betaFile))

  await mounted.press({ type: 'ListItem', label: 'Alpha' })
  assert.deepEqual(currentRow(), ['Alpha'])
  assert.match(mounted.find({ text: /model-alpha/ })?.text ?? '', /model-alpha/)
  const lastStatus = (mounted.host.callsOf('plugin.request') as { name: string; input: unknown }[])
    .filter((call) => call.name === 'session.status').at(-1)
  assert.equal(requestFile(lastStatus?.input), alphaFile)
})

test('session order keeps its slots and only appends new sessions', () => {
  const row = (file: string, active = false) => ({ file, dir: 'sessions', ageMs: 0, active, title: file, cwd: null })
  const alpha = row('C:\\sessions\\alpha.jsonl')
  const beta = row('C:\\sessions\\beta.jsonl')
  const gamma = row('C:\\sessions\\gamma.jsonl', true)
  // The worker sorts by mtime. A flip in its answer must not move open rows.
  assert.deepEqual(panel.mergeSessionRows([alpha, beta], [beta, alpha]).map((item) => item.file), [alpha.file, beta.file])
  // A new session appears at the end, so the rail above it does not shift.
  assert.deepEqual(panel.mergeSessionRows([alpha, beta], [beta, gamma, alpha]).map((item) => item.file), [alpha.file, beta.file, gamma.file])
})

test('the selected thinking level is highlighted, not a gray ghost', async () => {
  mounted = await mount(panel, {
    host: mockHost({
      requests: {
        ...requests,
        'fusion.status': { models, fusion: { ...fusion, fromEffort: 'xhigh' } },
      },
    }),
  })
  assert.deepEqual(mounted.errors, [])
  await mounted.select({ type: 'Tabs' }, 'orzic')
  const buttons = (label: string) => mounted!.findAll({ type: 'Button', text: label })
  // The planner card is drawn before the executor card, so [0] is the planner
  // row and [1] the executor row. Both use the same model, so every level is
  // drawn twice; the count assertion keeps an extra rendering visible.
  const xhighRows = buttons('xhigh')
  assert.equal(xhighRows.length, 2, 'xhigh must be drawn in both rows')
  const [plannerXhigh, executorXhigh] = xhighRows
  assert.equal(plannerXhigh?.props.variant, 'solid')
  assert.equal(plannerXhigh?.props.tone, 'accent')
  assert.equal(executorXhigh?.props.variant, 'ghost')
  assert.equal(executorXhigh?.props.tone, 'neutral')

  for (const label of ['默认', 'low', 'medium', 'high', 'max']) {
    const rows = buttons(label)
    assert.equal(rows.length, 2, `${label} must be drawn in both rows`)
    assert.equal(rows[0]?.props.variant, 'ghost', `planner ${label} must not look selected`)
    assert.equal(rows[0]?.props.tone, 'neutral', `planner ${label} must not carry the accent tone`)
    // The executor's own selected level is its default (`intoEffort: null`) and
    // must be highlighted independently of the planner's xhigh.
    const expected = label === '默认' ? { variant: 'solid', tone: 'accent' } : { variant: 'ghost', tone: 'neutral' }
    assert.equal(rows[1]?.props.variant, expected.variant, `executor ${label} variant`)
    assert.equal(rows[1]?.props.tone, expected.tone, `executor ${label} tone`)
  }
})
