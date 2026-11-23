// Regression tests for the acceptance verdict parser.
// Run: node --test src/orzic-verdict.test.mjs
// The rule under test: a judge failure, empty output, or missing verdict must
// NEVER be reported as 'pass' — a broken review is not an approval.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verdictFromOutput } from './orzic-verdict.mjs'

const wrap = (text) => JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'

test('execFile error → failed, never pass', () => {
  const r = verdictFromOutput('{"verdict":"pass","findings":[]}', { error: 'exit 1' })
  assert.equal(r.verdict, 'failed')
})

test('empty stdout → failed, never pass', () => {
  assert.equal(verdictFromOutput('').verdict, 'failed')
  assert.equal(verdictFromOutput('   \n\n').verdict, 'failed')
})

test('no assistant message_end → failed, never pass', () => {
  const r = verdictFromOutput(JSON.stringify({ type: 'turn_end' }) + '\n' + JSON.stringify({ type: 'message_end', message: { role: 'user', content: [] } }))
  assert.equal(r.verdict, 'failed')
})

test('garbage verdict text → failed, never pass', () => {
  const r = verdictFromOutput(wrap('not json at all'))
  assert.equal(r.verdict, 'failed')
})

test('missing verdict field → failed, never pass', () => {
  const r = verdictFromOutput(wrap('{"findings":[]}'))
  assert.equal(r.verdict, 'failed')
})

test('unknown verdict value → failed, never pass', () => {
  const r = verdictFromOutput(wrap('{"verdict":"maybe","findings":[]}'))
  assert.equal(r.verdict, 'failed')
})

test('explicit pass → pass', () => {
  const r = verdictFromOutput(wrap('{"verdict":"pass","findings":[]}'))
  assert.equal(r.verdict, 'pass')
})

test('explicit rework → rework', () => {
  const r = verdictFromOutput(wrap('{"verdict":"rework","findings":[{"severity":"medium","file":"a.ts","line":3,"message":"x"}]}'))
  assert.equal(r.verdict, 'rework')
  assert.equal(r.findings.length, 1)
})

test('blocker severity finding → rework even if verdict says pass', () => {
  const r = verdictFromOutput(wrap('{"verdict":"pass","findings":[{"severity":"blocker","file":"a.ts","line":1,"message":"div by zero"}]}'))
  assert.equal(r.verdict, 'rework')
})

test('multiple message_end lines — last assistant text wins', () => {
  const out = wrap('{"verdict":"rework","findings":[]}') + wrap('{"verdict":"pass","findings":[]}')
  const r = verdictFromOutput(out)
  assert.equal(r.verdict, 'pass')
})
