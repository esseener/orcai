// Model picker regression tests. The devin provider ships ~1000 `fusion-*`
// combos next to its plain models, and they used to swallow every search:
// `swe2` matched ~285 fusion rows, all of them drawn before the real
// `devin/swe-2` fell past the 200-row cap. Run: orca plugin test .
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mount, mockHost, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { OmpModel } from './protocol'

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

async function openPicker() {
  mounted = await mount(panel, { host: mockHost({ requests }) })
  assert.deepEqual(mounted.errors, [])
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

test('Orcai exposes Orzic and 便签 as top-level modules', async () => {
  mounted = await mount(panel, { host: mockHost({ requests }) })
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.findAll({ type: 'Tab' }).map((tab) => tab.text), ['Orzic', '便签'])
  const images = (alt: string) => mounted!.findAll({ type: 'Image' }).filter((image) => image.props.alt === alt)
  const orzicTab = mounted.find({ type: 'Tab', text: 'Orzic' })
  const routingBadge = mounted.find({ text: '规划路由关' })
  const logo = images('Orcai')[0]
  assert.ok(orzicTab)
  assert.ok(routingBadge)
  assert.ok(logo)
  // The logo pair is global chrome; module status stays inside the Orzic tab.
  assert.equal(images('Orcai').length, 1)
  assert.ok(!logo.path.startsWith(`${orzicTab.path}/`), `logo ${logo.path} should be outside ${orzicTab.path}`)
  assert.ok(routingBadge.path.startsWith(`${orzicTab.path}/`), `routing badge ${routingBadge.path} should be inside ${orzicTab.path}`)
  await mounted.select({ type: 'Tabs', label: 'Orcai 功能模块' }, 'notes')
  assert.equal(mounted.find({ type: 'EmptyState', label: '还没有便签' })?.label, '还没有便签')
  assert.equal(images('Orcai').length, 1)
  assert.equal(mounted.find({ text: '规划路由关' }), null)
})

test('shows recent sessions with their own model and hides old records', async () => {
  const rows = [
    {
      file: 'C:\\sessions\\alpha.jsonl', dir: 'sessions', ageMs: 1_000, active: true, recent: true, title: 'Alpha', cwd: 'C:\\work\\alpha',
      model: 'model-alpha', thinking: 'high', stage: 'executing' as const, lastTool: 'edit', lastToolAt: '2026-11-24T05:00:00.000Z',
    },
    {
      file: 'C:\\sessions\\beta.jsonl', dir: 'sessions', ageMs: 2_000, active: false, recent: true, title: 'Beta', cwd: 'C:\\work\\beta',
      model: 'model-beta', thinking: null, stage: 'planning' as const, lastTool: null, lastToolAt: null,
    },
    {
      file: 'C:\\sessions\\gamma.jsonl', dir: 'sessions', ageMs: 3_600_000, active: false, recent: false, title: 'Gamma', cwd: 'C:\\work\\gamma',
      model: 'model-gamma', thinking: null, stage: 'unknown' as const, lastTool: null, lastToolAt: null,
    },
  ]
  mounted = await mount(panel, {
    host: mockHost({ requests: { ...requests, 'session.list': rows } }),
  })
  assert.deepEqual(mounted.errors, [])
  await mounted.settled()
  assert.ok(mounted.find({ text: 'Alpha' }))
  assert.ok(mounted.find({ text: 'Beta' }))
  assert.match(mounted.find({ text: /model-alpha/ })?.text ?? '', /model-alpha · high/)
  assert.match(mounted.find({ text: /model-beta/ })?.text ?? '', /model-beta/)
  // Old records still exist in the list response, but must not be drawn.
  assert.equal(mounted.find({ text: 'Gamma' }), null)
  assert.equal(mounted.find({ text: /model-gamma/ }), null)
  // One line between the two visible session blocks.
  assert.equal(mounted.findAll({ type: 'Separator' }).length, 1)
  // The list already carries each model; the panel must not fan out one
  // session.status call per row.
  const statusCalls = (mounted.host.callsOf('plugin.request') as { name: string }[])
    .filter((call) => call.name === 'session.status')
  assert.equal(statusCalls.length, 0)
})

test('session order keeps every seen file in its original slot', () => {
  const alpha = 'C:\\sessions\\alpha.jsonl'
  const beta = 'C:\\sessions\\beta.jsonl'
  const gamma = 'C:\\sessions\\gamma.jsonl'
  // The worker sorts by mtime. A flip in its answer must not move open rows.
  assert.deepEqual(panel.mergeSessionOrder([alpha, beta], [beta, alpha]), [alpha, beta])
  // A new session appears at the end, so the rail above it does not shift.
  assert.deepEqual(panel.mergeSessionOrder([alpha, beta], [beta, gamma, alpha]), [alpha, beta, gamma])
  // A session that disappears for one poll keeps its slot when it returns.
  assert.deepEqual(panel.mergeSessionOrder([alpha, beta, gamma], [alpha, gamma]), [alpha, beta, gamma])
  assert.deepEqual(panel.mergeSessionOrder([alpha, beta, gamma], [gamma, alpha, beta]), [alpha, beta, gamma])
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
