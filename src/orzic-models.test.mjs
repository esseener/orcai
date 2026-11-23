// Model catalog cache/single-flight tests.
// Run: node --test src/orzic-models.test.mjs
// A failed or slow listing must reject, never collapse to an empty catalog;
// concurrent panel retries must share one run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createModelCatalog, parseModelRows } from './orzic-models.mjs'

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
