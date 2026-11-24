// Compatibility smoke for the installed OMP: proves the extension still loads,
// routes a plan request to the planner, delivers the planning guidance, writes
// and snapshots PLAN.md through a real tool call, hands off to the executor,
// and gets a successful reply. Run after every OMP upgrade. Costs one short
// planner + executor turn.
//
//   node tools/smoke-omp.mjs [--keep]
//   ORZIC_OMP_BIN=... ORZIC_SMOKE_PLANNER=provider/model ORZIC_SMOKE_EXECUTOR=provider/model
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const omp = process.env.ORZIC_OMP_BIN || 'omp'
const planner = process.env.ORZIC_SMOKE_PLANNER || 'openai-codex/gpt-6-luna'
const executor = process.env.ORZIC_SMOKE_EXECUTOR || 'magpie/auto/deepseek-v4.1-flash'
const keep = process.argv.includes('--keep')
const agent = mkdtempSync(join(tmpdir(), 'orzic-smoke-'))
const work = join(agent, 'work')
const sessions = join(agent, 'sessions')
mkdirSync(work, { recursive: true })
mkdirSync(sessions, { recursive: true })

const stripEffort = (s) => s.replace(/:(off|minimal|low|medium|high|xhigh|max)$/i, '')
const splitModel = (selector) => {
  const base = stripEffort(selector)
  const slash = base.indexOf('/')
  return { provider: base.slice(0, slash), id: base.slice(slash + 1), base }
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  console.error(`agent dir kept at ${agent}`)
  process.exit(1)
}

writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({
  autoRoute: true, autoReview: false, autoRework: false,
  planner, executor,
}))

const prompt = '用 write 工具把 "# PLAN\n- smoke" 写入 PLAN.md，然后只回复 HANDOFF。不要读文件，不要执行其他工具。'
const args = [
  '--no-extensions', '-e', join(root, 'src', 'orzic-loop.ts'),
  '--no-skills', '--no-rules', '--no-context-files', '--no-prewalk', '--tools', 'write',
  '--model', executor, '--session-dir', sessions, '--cwd', work,
  '-p', prompt,
]
// A rework-injected OMP exports ORZIC_DRIVER=1; the smoke must never inherit
// that mode or it would skip routing entirely.
const env = { ...process.env, ORZIC_AGENT_DIR: agent }
delete env.ORZIC_DRIVER
delete env.ORZIC_CWD
delete env.ORZIC_SESSION_FILE
delete env.ORZIC_SPAWN_LOG

console.log(`omp ${args.join(' ')}`)
const run = spawnSync(omp, args, { cwd: work, encoding: 'utf8', timeout: 240_000, env })
if (run.error) fail(`cannot run ${omp}: ${run.error.message}`)
if (run.status !== 0) fail(`omp exited ${run.status}\n${run.stdout}\n${run.stderr}`)

const log = existsSync(join(agent, 'orzic-loop.log')) ? readFileSync(join(agent, 'orzic-loop.log'), 'utf8') : ''
if (!log.includes('extension loaded')) fail(`extension did not load\n${log}`)
if (!new RegExp(`route .*phase=planning selector=${esc(planner)} ok=true`).test(log)) {
  fail(`routing log missing planner switch\n${log}`)
}
const handoff = new RegExp(`handoff .*selector=${esc(executor)} ok=true`).test(log)
if (!handoff) fail(`PLAN.md handoff did not reach the executor\n${log}`)

const files = readdirSync(sessions).filter((f) => f.endsWith('.jsonl'))
if (!files.length) fail('no session file was written; sessionManager.getSessionFile may have changed')
const sessionFile = join(sessions, files[0])
const sessionText = readFileSync(sessionFile, 'utf8')
if (!sessionText.includes('orzic-planning')) fail('planning guidance was not delivered to the planner')

const plans = readdirSync(agent).filter((f) => f.startsWith('orzic-plan-') && f.endsWith('.json'))
if (plans.length !== 1) fail(`expected one plan snapshot, found ${plans.length}\n${log}`)
const plan = JSON.parse(readFileSync(join(agent, plans[0]), 'utf8'))
if (plan.approved !== true) fail('plan snapshot is not approved')
if (!String(plan.planContent ?? '').trim()) fail('plan snapshot is empty')
if (norm(plan.sessionFile) !== norm(sessionFile)) fail(`plan pinned to ${plan.sessionFile}, expected ${sessionFile}`)

const assistants = []
const changes = []
for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    const e = JSON.parse(line)
    if (e.type === 'message' && e.message?.role === 'assistant') {
      assistants.push({
        provider: e.message.provider ?? '',
        model: e.message.model ?? '',
        stop: e.message.stopReason ?? '',
        text: (e.message.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
      })
    }
    if (e.type === 'model_change' && typeof e.model === 'string') changes.push(e.model)
  } catch { /* skip partial line */ }
}
if (!assistants.length) fail('no assistant message; the turn was aborted or message_end changed')

const plannerId = splitModel(planner)
const executorId = splitModel(executor)
if (!assistants.some((m) => m.provider === plannerId.provider && m.model === plannerId.id && m.stop === 'toolUse')) {
  fail(`planner did not serve the PLAN.md write: ${JSON.stringify(assistants)}`)
}
const last = assistants.at(-1)
if (last.provider !== executorId.provider || last.model !== executorId.id) {
  fail(`last reply came from ${last.provider}/${last.model}, expected executor ${executor}`)
}
if (last.stop !== 'stop' || !last.text.trim()) {
  fail(`executor did not produce a successful reply: ${JSON.stringify(last)}`)
}
if (!changes.some((m) => m.startsWith(plannerId.base))) fail(`no planner model_change in ${JSON.stringify(changes)}`)
if (!changes.some((m) => m.startsWith(executorId.base))) fail(`no executor model_change in ${JSON.stringify(changes)}`)

console.log(`PASS: planner ${plannerId.provider}/${plannerId.id} wrote PLAN.md → executor ${executorId.provider}/${executorId.id} replied "${last.text.trim()}"`)
if (!keep) rmSync(agent, { recursive: true, force: true })
