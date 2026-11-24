import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ROUTING, ROUTING_LIMITS, missingPlanRequirements, normalizeRoutingRules, wantsExecution,
} from './orzic-routing.mjs'

test('routing rules default to built-in recognition and empty custom lists', () => {
  assert.deepEqual(normalizeRoutingRules(undefined), DEFAULT_ROUTING)
  assert.equal(wantsExecution('继续执行'), true)
  assert.equal(wantsExecution('重新规划一下'), false)
})

test('custom phrases are trimmed, de-duplicated, and capped', () => {
  const many = Array.from({ length: ROUTING_LIMITS.phrases + 5 }, (_, i) => `规则${i}`)
  const rules = normalizeRoutingRules({ replanPhrases: [' 换个方案 ', '换个方案', '', ...many], planRequired: ['## 验证'] })
  assert.equal(rules.replanPhrases[0], '换个方案')
  assert.equal(rules.replanPhrases.length, ROUTING_LIMITS.phrases)
  assert.deepEqual(rules.planRequired, ['## 验证'])
  assert.equal(rules.useBuiltin, true)
})

test('custom re-plan wins when a message contains both kinds', () => {
  const rules = normalizeRoutingRules({ replanPhrases: ['换个方案'], executePhrases: ['开始实现'] })
  assert.equal(wantsExecution('开始实现，但先换个方案', rules), false)
  assert.equal(wantsExecution('开始实现', rules), true)
})

test('built-in recognition can be disabled; custom phrases still apply', () => {
  const rules = normalizeRoutingRules({ useBuiltin: false, executePhrases: ['按我的做法'] })
  assert.equal(wantsExecution('继续执行', rules), false)
  assert.equal(wantsExecution('按我的做法', rules), true)
  assert.equal(wantsExecution('按我的做法', normalizeRoutingRules({ useBuiltin: false })), false)
})

test('plan requirements are literal and case-insensitive', () => {
  const rules = normalizeRoutingRules({ planRequired: ['## Steps', '## Verify'] })
  assert.deepEqual(missingPlanRequirements('# PLAN\n## Steps\n## Verify', rules), [])
  assert.deepEqual(missingPlanRequirements('# PLAN\n## steps', rules), ['## Verify'])
  assert.deepEqual(missingPlanRequirements('', rules), ['## Steps', '## Verify'])
})

test('old empty rules receive presets; an explicit empty save stays empty', () => {
  const legacy = normalizeRoutingRules({ useBuiltin: true, replanPhrases: [], executePhrases: [], planRequired: [] })
  assert.deepEqual(legacy.replanPhrases, [...DEFAULT_ROUTING.replanPhrases])
  assert.deepEqual(legacy.executePhrases, [...DEFAULT_ROUTING.executePhrases])
  const explicit = normalizeRoutingRules({ useBuiltin: true, presetVersion: 1, replanPhrases: [], executePhrases: [], planRequired: [] })
  assert.deepEqual(explicit.replanPhrases, [])
  assert.deepEqual(explicit.executePhrases, [])
})
