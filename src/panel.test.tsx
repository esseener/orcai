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
  const active = mounted.find({ type: 'Button', text: 'xhigh' })
  assert.equal(active?.props.variant, 'solid')
  assert.equal(active?.props.tone, 'accent')
  // Every other level must stay visually quiet; checking only one would let a
  // second highlighted button slip through.
  for (const label of ['默认', 'low', 'medium', 'high', 'max']) {
    const idle = mounted.find({ type: 'Button', text: label })
    assert.ok(idle, `${label} button should be drawn`)
    assert.equal(idle.props.variant, 'ghost', `${label} must not look selected`)
    assert.equal(idle.props.tone, 'neutral', `${label} must not carry the accent tone`)
  }
})
