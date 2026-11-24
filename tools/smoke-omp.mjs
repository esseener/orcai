// Compatibility smoke for the installed OMP: proves the extension still loads,
// receives before_agent_start with a prompt, and actually serves the turn with
// the planner model. Run after every OMP upgrade. Costs one short model call.
//
//   node tools/smoke-omp.mjs [--keep]
//   ORZIC_OMP_BIN=... ORZIC_SMOKE_PLANNER=provider/model ORZIC_SMOKE_EXECUTOR=provider/model
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const omp = process.env.ORZIC_OMP_BIN || 'omp'
const planner = process.env.ORZIC_SMOKE_PLANNER || 'openai-codex/gpt-6-luna'
const executor = process.env.ORZIC_SMOKE_EXECUTOR || 'magpie/auto/deepseek-v4.1-flash'
const keep = process.argv.includes('--keep')
const agent = mkdtempSync(join(tmpdir(), 'orzic-smoke-'))
const sessions = join(agent, 'sessions')
const prompt = '审查并做个计划：只回复收到，不要写文件。'

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  console.error(`agent dir kept at ${agent}`)
  process.exit(1)
}

writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({
  autoRoute: true, autoReview: false, autoRework: false,
  planner, executor,
}))

const args = [
  '--no-extensions', '-e', join(root, 'src', 'orzic-loop.ts'),
  '--no-skills', '--no-rules', '--no-context-files', '--no-prewalk',
  '--model', executor, '--session-dir', sessions,
  '-p', prompt,
]
console.log(`omp ${args.join(' ')}`)
const run = spawnSync(omp, args, {
  encoding: 'utf8',
  timeout: 180_000,
  env: { ...process.env, ORZIC_AGENT_DIR: agent },
})
if (run.error) fail(`cannot run ${omp}: ${run.error.message}`)
if (run.status !== 0) fail(`omp exited ${run.status}\n${run.stdout}\n${run.stderr}`)

const log = existsSync(join(agent, 'orzic-loop.log')) ? readFileSync(join(agent, 'orzic-loop.log'), 'utf8') : ''
if (!log.includes('extension loaded')) fail(`extension did not load\n${log}`)
if (!new RegExp(`route .*phase=planning selector=${planner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ok=true`).test(log)) {
  fail(`routing log missing planner switch\n${log}`)
}
if (/phase=executing/.test(log)) fail(`a plan-only prompt reached execution\n${log}`)

const files = existsSync(sessions) ? readdirSync(sessions).filter((f) => f.endsWith('.jsonl')) : []
if (!files.length) fail('no session file was written; sessionManager.getSessionFile may have changed')
const lines = readFileSync(join(sessions, files[0]), 'utf8').split('\n').filter(Boolean)
const assistants = []
for (const line of lines) {
  try {
    const e = JSON.parse(line)
    if (e.type === 'message' && e.message?.role === 'assistant') assistants.push(e.message.model ?? '')
  } catch { /* skip partial line */ }
}
if (!assistants.length) fail('no assistant message; the turn was aborted or message_end changed')
const plannerId = planner.replace(/:(off|minimal|low|medium|high|xhigh|max)$/i, '').split('/').pop()
for (const model of assistants) {
  if (model !== plannerId) fail(`assistant served by ${model}, expected planner ${plannerId}`)
}
console.log(`PASS: extension loaded, routed to ${planner}, assistant model ${assistants.at(-1)}`)
if (!keep) rmSync(agent, { recursive: true, force: true })
