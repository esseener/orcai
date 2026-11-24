import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ROUTING, ROUTING_LIMITS, missingPlanRequirements, normalizeRoutingRules, wantsExecution,
} from './orzic-routing.mjs'

test('routing rules default to built-in recognition without changing legacy lists', () => {
  const rules = normalizeRoutingRules(undefined)
  assert.equal(rules.useBuiltin, true)
  assert.equal(rules.presetVersion, 0)
  assert.deepEqual(rules.replanPhrases, [])
  assert.deepEqual(rules.executePhrases, [])
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

test('old empty rules stay empty; the editor supplies presets separately', () => {
  const legacy = normalizeRoutingRules({ useBuiltin: true, replanPhrases: [], executePhrases: [], planRequired: [] })
  assert.equal(legacy.presetVersion, 0)
  assert.deepEqual(legacy.replanPhrases, [])
  assert.deepEqual(legacy.executePhrases, [])
  const explicit = normalizeRoutingRules({ useBuiltin: true, presetVersion: 1, replanPhrases: [], executePhrases: [], planRequired: [] })
  assert.deepEqual(explicit.replanPhrases, [])
  assert.deepEqual(explicit.executePhrases, [])
  assert.deepEqual(DEFAULT_ROUTING.replanPhrases, [
    '重新规划', '重新计划', '重新评估',
    '审查一下', '评估一下', '分析一下', '复盘一下', '拆解一下',
    '先做计划', '先写计划', '先给方案', '换个方案', '换一个方案', '换个思路',
    '不要直接执行', '不要开始执行', '不要开始实现', '不要继续执行', '不要执行', '先别执行',
  ])
})

test('presets do not override re-plan intent or match negated English', () => {
  assert.equal(wantsExecution('先评估风险，再决定是否开始执行', DEFAULT_ROUTING), false)
  assert.equal(wantsExecution('Please do not implement it yet.', DEFAULT_ROUTING), false)
  assert.equal(wantsExecution('这次会议什么时候开始？', DEFAULT_ROUTING), false)
  assert.equal(wantsExecution('开始吧', DEFAULT_ROUTING), true)
  assert.equal(wantsExecution('开始执行吧。', DEFAULT_ROUTING), true)
})
