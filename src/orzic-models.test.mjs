// Model catalog cache/single-flight tests.
// Run: node --test src/orzic-models.test.mjs
// A failed or slow listing must reject, never collapse to an empty catalog;
// concurrent panel retries must share one run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createModelCatalog, filterModelChoices, isFusionModel, parseModelRows } from './orzic-models.mjs'

test('concurrent loads share one run and reuse its cache', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const load = createModelCatalog({
    run: async () => { calls++; await gate; return [{ id: 'm' }] }
  })
  const first = load()
  const second = load()
  const third = load()
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await first, [{ id: 'm' }])
  assert.deepEqual(await second, [{ id: 'm' }])
  assert.deepEqual(await third, [{ id: 'm' }])
  await load()
  assert.equal(calls, 1)
})

test('failure propagates and clears pending for the next attempt', async () => {
  let calls = 0
  const load = createModelCatalog({
    run: async () => { calls++; throw new Error('boom') }
  })
  await assert.rejects(load(), /boom/)
  await assert.rejects(load(), /boom/)
  assert.equal(calls, 2)
})

test('cache expires after ttl', async () => {
  let now = 0
  let calls = 0
  const load = createModelCatalog({
    now: () => now,
    ttl: 1_000,
    run: async () => { calls++; return [{ id: `m${calls}` }] }
  })
  assert.equal((await load())[0].id, 'm1')
  now = 999
  assert.equal((await load())[0].id, 'm1')
  assert.equal(calls, 1)
  now = 1_001
  assert.equal((await load())[0].id, 'm2')
  assert.equal(calls, 2)
})

test('a failed refresh never becomes an empty success', async () => {
  let now = 0
  let calls = 0
  const load = createModelCatalog({
    now: () => now,
    ttl: 100,
    run: async () => {
      calls++
      if (calls === 1) return [{ id: 'cached' }]
      throw new Error('models ls timed out')
    }
  })
  assert.equal((await load())[0].id, 'cached')
  now = 200
  await assert.rejects(load(), /timed out/)
  await assert.rejects(load(), /timed out/)
  assert.equal(calls, 3)
})

test('non-array output is an error, not an empty catalog', async () => {
  const load = createModelCatalog({ run: async () => undefined })
  await assert.rejects(load(), /无效的模型列表/)
})

test('an empty array is a valid empty catalog', () => {
  assert.deepEqual(parseModelRows([]), [])
})

test('rows with selector or id are mapped', () => {
  const models = parseModelRows([
    { selector: 'p/m:high', name: 'M', provider: 'p', thinking: ['low', 7, 'high'] },
    { id: 'p/n' },
  ])
  assert.deepEqual(models, [
    { id: 'p/m:high', name: 'M', provider: 'p', thinking: ['low', 'high'] },
    { id: 'p/n', name: 'p/n', provider: undefined, thinking: [] },
  ])
})

test('non-empty rows with no usable id are an error, not an empty catalog', () => {
  assert.throws(() => parseModelRows([{ name: 'no id' }, { selector: '' }]), /没有可用的 selector\/id/)
})

test('non-array output is an error at the parser too', () => {
  assert.throws(() => parseModelRows(undefined), /无效的模型列表/)
})

test('force bypasses a fresh cache', async () => {
  let calls = 0
  const load = createModelCatalog({ run: async () => { calls++; return [{ id: `m${calls}` }] } })
  assert.equal((await load())[0].id, 'm1')
  assert.equal((await load())[0].id, 'm1')
  assert.equal(calls, 1)
  assert.equal((await load(true))[0].id, 'm2')
  assert.equal(calls, 2)
})

test('blank selector falls back to a non-blank id', () => {
  const models = parseModelRows([
    { selector: '   ', id: 'p/m' },
    { selector: '', id: 'p/n' },
    { selector: 'p/o', id: 'p/ignored' },
  ])
  assert.deepEqual(models.map((m) => m.id), ['p/m', 'p/n', 'p/o'])
})

test('whitespace-only identifiers are rejected', () => {
  assert.throws(() => parseModelRows([{ selector: '  ', id: '\t' }]), /没有可用的 selector\/id/)
})

const fusionModel = (id) => ({ id, name: id.split('/').pop(), thinking: [] })

test('fusion combos are recognised by id segment, not by loose substring', () => {
  assert.equal(isFusionModel(fusionModel('devin/fusion-claude-opus-5-high-sidekick-swe-2-high')), true)
  assert.equal(isFusionModel(fusionModel('devin/fusion-alpha')), true)
  assert.equal(isFusionModel(fusionModel('devin/swe-2')), false)
  assert.equal(isFusionModel(fusionModel('magpie/fusionless-model')), false)
  assert.equal(isFusionModel({ id: 'x/infusion' }), false)
  assert.equal(isFusionModel({}), false)
})

test('picker hides fusion combos that outnumber and overshadow the real model', () => {
  // Devin's real catalog: ~285 fusion ids contain `swe-2`, one plain model is
  // `devin/swe-2`. Before this filter the row cap hid the real entry entirely.
  const models = [
    ...Array.from({ length: 285 }, (_, i) => fusionModel(`devin/fusion-claude-fable-5-1-high-sidekick-swe-2-${i}`)),
    { id: 'devin/swe-2', name: 'SWE-2', thinking: ['high'] },
    { id: 'devin/swe-2-flash', name: 'SWE-2 Flash', thinking: [] },
  ]
  assert.deepEqual(filterModelChoices(models, 'swe2').map((m) => m.id), ['devin/swe-2', 'devin/swe-2-flash'])
  assert.equal(filterModelChoices(models, 'swe').length, 2)
  assert.equal(filterModelChoices(models, '').length, 2)
})

test('search ignores separators so swe2 finds devin/swe-2', () => {
  const models = [
    { id: 'devin/swe-1-6', name: 'SWE-1.6', thinking: [] },
    { id: 'magpie/gpt-5-4', name: 'GPT-5.4', thinking: [] },
  ]
  assert.deepEqual(filterModelChoices(models, 'swe2').map((m) => m.id), [])
  assert.deepEqual(filterModelChoices(models, 'swe16').map((m) => m.id), ['devin/swe-1-6'])
  assert.deepEqual(filterModelChoices(models, 'gpt54').map((m) => m.id), ['magpie/gpt-5-4'])
  assert.deepEqual(filterModelChoices(models, '  SWE-1.6  ').map((m) => m.id), ['devin/swe-1-6'])
})

test('exact and prefix id hits rank above loose name hits', () => {
  const models = [
    { id: 'devin/not-sol', name: 'Sol Legacy', thinking: [] },
    { id: 'devin/sol-fast', name: 'Sol Fast', thinking: [] },
    { id: 'devin/sol', name: 'Sol', thinking: [] },
  ]
  assert.deepEqual(filterModelChoices(models, 'sol').map((m) => m.id), ['devin/sol', 'devin/sol-fast', 'devin/not-sol'])
})

test('empty query keeps catalog order and the row cap', () => {
  const models = Array.from({ length: 250 }, (_, i) => ({ id: `p/m${i}`, name: `m${i}`, thinking: [] }))
  const listed = filterModelChoices(models, '')
  assert.equal(listed.length, 200)
  assert.equal(listed[0].id, 'p/m0')
  assert.equal(filterModelChoices(models, '', { limit: 5 }).length, 5)
})
