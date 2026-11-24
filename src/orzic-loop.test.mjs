import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import loop from './orzic-loop.ts'

const setup = (overrides = {}, models = [{ provider: 'planner', id: 'plan' }, { provider: 'executor', id: 'code' }], options = {}) => {
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
  const aborts = []
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
      const selector = `${model.provider}/${model.id}`
      if (options.deny?.includes(selector)) return false
      setModels.push(selector)
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
    abort: () => { aborts.push(file) },
  })
  const fire = async (name, event, ctx) => {
    const fn = handlers[name]
    if (fn) return fn(event, ctx)
  }
  const plans = () => readdirSync(agent).filter((f) => f.startsWith('orzic-plan-'))
  return { agent, cwd, ctxFor, fire, plans, setModels, aborts, levels }
}

const completePlanWrite = async (env, ctx, { content = '# PLAN', id = 'call-1', isError = false } = {}) => {
  const blocked = await env.fire('tool_call', { toolCallId: id, toolName: 'write', input: { path: 'PLAN.md', content } }, ctx)
  if (!isError) writeFileSync(join(env.cwd, 'PLAN.md'), content)
  await env.fire('tool_execution_end', { toolCallId: id, toolName: 'write', isError, result: {} }, ctx)
  return blocked
}

const completeWrite = async (env, ctx, { id = 'w-1', toolName = 'write', path = 'src/a.ts', isError = false } = {}) => {
  await env.fire('tool_call', { toolCallId: id, toolName, input: { path, content: 'x' } }, ctx)
  await env.fire('tool_execution_end', { toolCallId: id, toolName, isError, result: {} }, ctx)
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

test('after a completed PLAN.md write, an explicit continuation keeps the executor', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a2.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await completePlanWrite(env, ctx)
  await env.fire('before_agent_start', { prompt: '继续' }, ctx)
  assert.deepEqual(env.setModels, ['planner/plan', 'executor/code', 'executor/code'])
})

test('a failed PLAN.md write never switches to the executor', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a2f.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await completePlanWrite(env, ctx, { isError: true })
  assert.deepEqual(env.setModels, ['planner/plan'])
  assert.equal(env.plans().length, 0)
  const bash = await env.fire('tool_call', { toolCallId: 'x', toolName: 'bash', input: { command: 'ls' } }, ctx)
  assert.equal(bash?.block, true)
})

test('an empty PLAN.md write is blocked and does not hand off', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a2e.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  const blocked = await env.fire('tool_call', { toolCallId: 'empty', toolName: 'write', input: { path: 'PLAN.md', content: '   ' } }, ctx)
  assert.equal(blocked?.block, true)
  await env.fire('tool_execution_end', { toolCallId: 'empty', toolName: 'write', isError: false, result: {} }, ctx)
  assert.deepEqual(env.setModels, ['planner/plan'])
  assert.equal(env.plans().length, 0)
})

test('an executor that cannot be applied aborts and keeps planning', async () => {
  const env = setup({}, undefined, { deny: ['executor/code'] })
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a2x.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await completePlanWrite(env, ctx)
  assert.equal(env.aborts.length, 1)
  assert.equal(env.plans().length, 0)
  const bash = await env.fire('tool_call', { toolCallId: 'x2', toolName: 'bash', input: { command: 'ls' } }, ctx)
  assert.equal(bash?.block, true)
})

test('after a handoff, a new review request returns to the planner', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a3.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await completePlanWrite(env, ctx)
  await env.fire('before_agent_start', { prompt: '再审查一下整个项目，做个计划' }, ctx)
  assert.equal(env.setModels.at(-1), 'planner/plan')
})

test('a prefixed continuation is a new request and returns to the planner', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a3p.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await completePlanWrite(env, ctx)
  await env.fire('before_agent_start', { prompt: '继续审查并做计划' }, ctx)
  assert.equal(env.setModels.at(-1), 'planner/plan')
})

test('a continuation while still planning stays on the planner', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a3c.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await env.fire('before_agent_start', { prompt: '继续' }, ctx)
  assert.deepEqual(env.setModels, ['planner/plan', 'planner/plan'])
})

test('an unavailable planner aborts and never applies the executor', async () => {
  const env = setup({}, [{ provider: 'executor', id: 'code' }])
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a4.jsonl'))
  await assert.rejects(env.fire('before_agent_start', { prompt: '审查并做计划' }, ctx), /规划模型不可用/)
  assert.equal(env.aborts.length, 1)
  assert.deepEqual(env.setModels, [])
})

test('setModel false aborts instead of falling back to the executor', async () => {
  const env = setup({}, undefined, { deny: ['planner/plan'] })
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a5.jsonl'))
  await assert.rejects(env.fire('before_agent_start', { prompt: '审查并做计划' }, ctx), /规划模型不可用/)
  assert.equal(env.aborts.length, 1)
  assert.deepEqual(env.setModels, [])
})

test('a missing planner aborts instead of running on the current model', async () => {
  const env = setup({ planner: null })
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'a6.jsonl'))
  await assert.rejects(env.fire('before_agent_start', { prompt: '审查并做计划' }, ctx), /未配置规划模型/)
  assert.equal(env.aborts.length, 1)
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
  const ev = await env.fire('tool_call', { toolName: 'eval', input: { code: 'open("x","w").write("y")' } }, ctx)
  assert.equal(ev?.block, true)
})

test('plan: a completed PLAN.md write snapshots it and switches to executor', async () => {
  const env = setup()
  const session = join(env.agent, 'sessions', 'c.jsonl')
  const ctx = env.ctxFor(session)
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await completePlanWrite(env, ctx, { content: '# PLAN\n步骤' })
  assert.deepEqual(env.setModels, ['planner/plan', 'executor/code'])
  const [file] = env.plans()
  const d = JSON.parse(readFileSync(join(env.agent, file), 'utf8'))
  assert.equal(d.approved, true)
  assert.equal(d.sessionFile, session)
  assert.match(d.digest, /^[0-9a-f]{64}$/)
  assert.match(d.planContent, /步骤/)
})

test('plan: agent_end does not approve a PLAN.md left by an earlier session', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'd.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  writeFileSync(join(env.cwd, 'PLAN.md'), '# HISTORICAL')
  await env.fire('agent_end', { willContinue: false }, ctx)
  assert.equal(env.plans().length, 0)
  const bash = await env.fire('tool_call', { toolCallId: 'h', toolName: 'bash', input: { command: 'ls' } }, ctx)
  assert.equal(bash?.block, true)
})

test('plan: agent_end with willContinue keeps planning state', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'd2.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await env.fire('agent_end', { willContinue: true }, ctx)
  const bash = await env.fire('tool_call', { toolCallId: 'h2', toolName: 'bash', input: { command: 'ls' } }, ctx)
  assert.equal(bash?.block, true)
})

test('plan: selectors with :effort still resolve', async () => {
  const env = setup({ planner: 'planner/plan:high', executor: 'executor/code:max' })
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'g.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await completePlanWrite(env, ctx)
  assert.deepEqual(env.setModels, ['planner/plan', 'executor/code'])
  assert.deepEqual(env.levels, ['high', 'max'])
})

test('agent_end: a completed write turn spawns the driver exactly once', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'e.jsonl'))
  await env.fire('agent_start', {}, ctx)
  await completeWrite(env, ctx)
  await env.fire('agent_end', { willContinue: false }, ctx)
  assert.equal(existsSync(join(env.agent, 'spawn.json')), true)
  const first = readFileSync(join(env.agent, 'spawn.json'), 'utf8')
  await env.fire('agent_end', { willContinue: false }, ctx)
  assert.equal(readFileSync(join(env.agent, 'spawn.json'), 'utf8'), first)
})

test('agent_end: a blocked planning write does not spawn review', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'e2.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  const blocked = await env.fire('tool_call', { toolCallId: 'blocked', toolName: 'write', input: { path: 'src/a.ts', content: 'x' } }, ctx)
  assert.equal(blocked?.block, true)
  await env.fire('agent_end', { willContinue: false }, ctx)
  assert.equal(existsSync(join(env.agent, 'spawn.json')), false)
})

test('agent_end: a failed write does not spawn review', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'e3.jsonl'))
  await env.fire('agent_start', {}, ctx)
  await completeWrite(env, ctx, { isError: true })
  await env.fire('agent_end', { willContinue: false }, ctx)
  assert.equal(existsSync(join(env.agent, 'spawn.json')), false)
})

test('agent_end: handing off the plan does not spawn review', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'e4.jsonl'))
  await env.fire('before_agent_start', { prompt: '重构验收循环，拆解成步骤再实现' }, ctx)
  await completePlanWrite(env, ctx)
  await env.fire('agent_end', { willContinue: false }, ctx)
  assert.equal(existsSync(join(env.agent, 'spawn.json')), false)
})

test('agent_end: no write means no spawn', async () => {
  const env = setup()
  const ctx = env.ctxFor(join(env.agent, 'sessions', 'f.jsonl'))
  await env.fire('agent_start', {}, ctx)
  await env.fire('agent_end', { willContinue: false }, ctx)
  assert.equal(existsSync(join(env.agent, 'spawn.json')), false)
})
