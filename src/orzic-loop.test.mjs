import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import loop from './orzic-loop.ts'

const setup = (overrides = {}, models = [{ provider: 'planner', id: 'plan' }, { provider: 'executor', id: 'code' }]) => {
  const agent = mkdtempSync(join(tmpdir(), 'orzic-loop-'))
  process.env.ORZIC_AGENT_DIR = agent
  process.env.ORZIC_SPAWN_LOG = join(agent, 'spawn.json')
  delete process.env.ORZIC_DRIVER
  const cwd = join(agent, 'repo')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({
    autoRoute: true, autoReview: true, autoRework: true, maxRework: 3,
    planner: 'planner/plan', executor: 'executor/code',
    ...overrides,
  }))
  mkdirSync(join(agent, 'extensions'), { recursive: true })
  writeFileSync(join(agent, 'extensions', 'orzic-driver.mjs'), '// stub')

  const handlers = {}
  const setModels = []
  const levels = []
  const pi = {
    on: (name, fn) => {
      const previous = handlers[name]
      handlers[name] = previous
        ? async (...args) => { const first = await previous(...args); const second = await fn(...args); return second ?? first }
        : fn
    },
    setModel: async (model) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      setModels.push(`${model.provider}/${model.id}`)
    },
    setThinkingLevel: (level) => { levels.push(level) },
  }
  loop(pi)

  const ctxFor = (file) => ({
    cwd,
    model: models[1],
    modelRegistry: { getAvailable: () => models },
    sessionManager: { getSessionFile: () => file },
    ui: { notify: () => {} },
  })
  const fire = async (name, event, ctx) => {
    const fn = handlers[name]
    if (fn) return fn(event, ctx)
  }
  const plans = () => readdirSync(agent).filter((f) => f.startsWith('orzic-plan-'))
  return { agent, cwd, ctxFor, fire, plans, setModels, levels }
}

test('session_start: shows the planner model by default', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 's.jsonl'))
  await env.fire('session_start', {}, ctx)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(env.setModels, ['planner/plan'])
})

test('regression: a review-and-plan request stays on the planner', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'r.jsonl'))
  await env.fire('session_start', {}, ctx)
  // The exact prompt from the sheet-metal project: length and phrasing used to
  // classify it as direct execution, skipping the configured planner.
  await env.fire('before_agent_start', { prompt: '重新审查一下这个项目，然后把前面没有做完的内容把它拉出来，做个计划。' }, ctx)
  assert.deepEqual(env.setModels, ['planner/plan', 'planner/plan'])
})

test('a new session treats a short message as planning, not execution', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a.jsonl'))
  await env.fire('before_agent_start', { prompt: '好' }, ctx)
  assert.deepEqual(env.setModels, ['planner/plan'])
  assert.equal(env.plans().length, 0)
})

test('after a PLAN.md handoff, an explicit continuation keeps the executor', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a2.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await env.fire('tool_call', { toolName: 'write', input: { path: 'PLAN.md', content: '# PLAN' } }, ctx)
  await env.fire('before_agent_start', { prompt: '继续' }, ctx)
  assert.deepEqual(env.setModels, ['planner/plan', 'executor/code', 'executor/code'])
})

test('after a handoff, a new review request returns to the planner', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a3.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await env.fire('tool_call', { toolName: 'write', input: { path: 'PLAN.md', content: '# PLAN' } }, ctx)
  await env.fire('before_agent_start', { prompt: '再审查一下整个项目，做个计划' }, ctx)
  assert.equal(env.setModels.at(-1), 'planner/plan')
})

test('an unavailable planner fails closed instead of using the executor', async () => {
  const env = setup({}, [{ provider: 'executor', id: 'code' }])
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a4.jsonl'))
  await assert.rejects(env.fire('before_agent_start', { prompt: '审查并做计划' }, ctx), /规划模型不可用/)
  assert.deepEqual(env.setModels, [])
})

test('plan: routes to planner and blocks non-plan writes and bash', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'b.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  assert.deepEqual(env.setModels, ['planner/plan'])
  const write = await env.fire('tool_call', { toolName: 'write', input: { path: 'src/a.ts', content: 'x' } }, ctx)
  assert.equal(write?.block, true)
  const bash = await env.fire('tool_call', { toolName: 'bash', input: { command: 'ls' } }, ctx)
  assert.equal(bash?.block, true)
})

test('plan: writing PLAN.md snapshots it and switches to executor', async () => {
  const env = setup()
  const session = join(env.agent, 'sessions', 'c.jsonl')
  const ctx = env.ctxFor(session)
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await env.fire('tool_call', { toolName: 'write', input: { path: 'PLAN.md', content: '# PLAN\n步骤' } }, ctx)
  assert.deepEqual(env.setModels, ['planner/plan', 'executor/code'])
  const [file] = env.plans()
  const d = JSON.parse(readFileSync(join(env.agent, file), 'utf8'))
  assert.equal(d.approved, true)
  assert.equal(d.sessionFile, session)
  assert.match(d.digest, /^[0-9a-f]{64}$/)
})

test('plan: agent_end snapshots an edited PLAN.md', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'd.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  writeFileSync(join(env.cwd, 'PLAN.md'), '# EDITED')
  await env.fire('agent_end', { willContinue: false }, ctx)
  const [file] = env.plans()
  const d = JSON.parse(readFileSync(join(env.agent, file), 'utf8'))
  assert.match(d.planContent, /EDITED/)
})

test('plan: selectors with :effort still resolve', async () => {
  const env = setup({ planner: 'planner/plan:high', executor: 'executor/code:max' })
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'g.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await env.fire('tool_call', { toolName: 'write', input: { path: 'PLAN.md', content: '# PLAN' } }, ctx)
  assert.deepEqual(env.setModels, ['planner/plan', 'executor/code'])
  assert.deepEqual(env.levels, ['high', 'max'])
})

test('agent_end: a write turn spawns the driver exactly once', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'e.jsonl'))
  await env.fire('agent_start', {}, ctx)
  await env.fire('tool_call', { toolName: 'write', input: { path: 'src/a.ts' } }, ctx)
  await env.fire('agent_end', { willContinue: false }, ctx)
  assert.equal(existsSync(join(env.agent, 'spawn.json')), true)
  const first = readFileSync(join(env.agent, 'spawn.json'), 'utf8')
  await env.fire('agent_end', { willContinue: false }, ctx)
  assert.equal(readFileSync(join(env.agent, 'spawn.json'), 'utf8'), first)
})

test('agent_end: no write means no spawn', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'f.jsonl'))
  await env.fire('agent_start', {}, ctx)
  await env.fire('agent_end', { willContinue: false }, ctx)
  assert.equal(existsSync(join(env.agent, 'spawn.json')), false)
})
