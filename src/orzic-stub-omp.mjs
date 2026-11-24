// Test-only stub for `omp`. Records every invocation as JSON lines in
// $ORZIC_AGENT_DIR/orzic-stub-calls.jsonl, then emits a canned response:
//   ORZIC_STUB_MODE=rework|pass|error|empty
// Judge calls (--mode json) print an ndjson message_end; `-r` resume calls
// just succeed after logging.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoKey } from './orzic-repokey.mjs'
import { readLock } from './orzic-lock.mjs'

const agent = process.env.ORZIC_AGENT_DIR || process.cwd()
const mode = process.env.ORZIC_STUB_MODE || 'pass'
const args = process.argv.slice(2)
try { appendFileSync(join(agent, 'orzic-stub-calls.jsonl'), JSON.stringify({ args }) + '\n') } catch { /* ignore */ }

// ORZIC_STUB_STOP_ON_INJECT=kill|stop: emulate the panel's stop arriving while
// the driver is busy inside `omp -r`. The token is lifted from the driver's own
// lock — a force-stop must target the OWNING run, never a recycled pid.
const cwd = process.env.ORZIC_CWD || process.cwd()
const key = repoKey(cwd)
if (process.env.ORZIC_STUB_STOP_ON_INJECT && args[0] === '-r') {
  let token = ''
  try { token = readLock(join(agent, `orzic-driver-${key}.lock`))?.token ?? '' } catch { /* ignore */ }
  const kill = process.env.ORZIC_STUB_STOP_ON_INJECT === 'kill'
  try { writeFileSync(join(agent, `orzic-stop-${key}`), JSON.stringify({ at: new Date().toISOString(), token, kill })) } catch { /* ignore */ }
}

// ORZIC_STUB_GRANDCHILD=1: on `-r`, spawn a grandchild that outlives the stub —
// proof the driver's force-stop killed the WHOLE tree, not just the direct
// child. pid written to orzic-grandchild.pid for the test to assert on.
// POSIX keeps it NON-detached so it stays in the driver's `kill(-pid)` group;
// Windows detaches it — `taskkill /T` still reaches it (verified). The fixture
// self-terminates after 120s so a leaked run can't pin CI forever.
if (process.env.ORZIC_STUB_GRANDCHILD && args[0] === '-r') {
  try {
    const { spawn } = await import('node:child_process')
    const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 120_000).unref()'], { detached: process.platform === 'win32', stdio: 'ignore', windowsHide: true })
    writeFileSync(join(agent, 'orzic-grandchild.pid'), String(g.pid))
    g.unref()
  } catch { /* ignore */ }
}
// ORZIC_STUB_SLEEP_MS: keep the `-r` child alive this long — models a real
// `omp -r` session that stays resident, so force-stop has a live child to kill.
if (process.env.ORZIC_STUB_SLEEP_MS && args[0] === '-r') {
  await new Promise((r) => setTimeout(r, parseInt(process.env.ORZIC_STUB_SLEEP_MS, 10) || 0))
}

if (mode === 'error') { process.stderr.write('stub error\n'); process.exit(1) }
if (mode === 'empty') { process.exit(0) }

// ORZIC_STUB_CFG_PATCH_ON_JUDGE='{"autoReview":false}': mutate the acceptance
// config while the judge is running, to prove the driver re-reads it before
// deciding whether to inject.
const cfgPatch = process.env.ORZIC_STUB_CFG_PATCH_ON_JUDGE
if (cfgPatch && args[0] === '--model') {
  try {
    const p = join(agent, 'orzic-acceptance.json')
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    writeFileSync(p, JSON.stringify({ ...cfg, ...JSON.parse(cfgPatch) }))
  } catch { /* ignore */ }
}

// ORZIC_STUB_STOP_ON_JUDGE=1: write the cooperative stop flag while the judge
// is running, so the driver must not start `omp -r` afterwards.
if (process.env.ORZIC_STUB_STOP_ON_JUDGE && args[0] === '--model') {
  let token = ''
  try { token = readLock(join(agent, `orzic-driver-${key}.lock`))?.token ?? '' } catch { /* ignore */ }
  try { writeFileSync(join(agent, `orzic-stop-${key}`), JSON.stringify({ at: new Date().toISOString(), token })) } catch { /* ignore */ }
}

const verdict = mode === 'rework' ? 'rework' : 'pass'
const findings = verdict === 'rework' ? [{ severity: 'medium', file: 'a.ts', line: 1, message: 'stub finding' }] : []
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ verdict, findings }) }] },
}) + '\n')
process.exit(0)
