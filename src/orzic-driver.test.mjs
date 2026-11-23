// Regression tests for driver lock + session pinning (fail-closed) +
// an end-to-end driver loop against a stub omp binary.
// Run: node --test src/orzic-driver.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireLock, heartbeatLock, lockHeld, readLock, releaseLock } from './orzic-lock.mjs'
import { repoKey } from './orzic-repokey.mjs'
import { resolveSession } from './orzic-session.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DRIVER = join(here, 'orzic-driver.mjs')
const STUB = join(here, 'orzic-stub-omp.mjs')
const NODE = process.execPath

const mkAgent = () => mkdtempSync(join(tmpdir(), 'orzic-agent-'))
const mkRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'orzic-repo-'))
  const git = (a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' })
  git(['init', '-q']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't'])
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  git(['add', '-A']); git(['commit', '-qm', 'init'])
  return dir
}
const mkSession = (root, cwd, name) => {
  const dir = join(root, `-${cwd.replace(/[:\\/]/g, '-')}`)
  mkdirSync(dir, { recursive: true })
  const f = join(dir, name)
  writeFileSync(f, JSON.stringify({ cwd, type: 'session' }) + '\n')
  return f
}
const runDriver = (env, ms = 60_000) => spawnSync(NODE, [DRIVER], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: ms, windowsHide: true })
const keyOf = (cwd) => repoKey(cwd)
const reviewOf = (agent, cwd) => JSON.parse(readFileSync(join(agent, `orzic-review-${keyOf(cwd)}.json`), 'utf8'))

// ---------- lock (directory protocol) ----------
const ownerFile = (dir, token) => join(dir, `owner-${token}.json`)
const writeOwner = (dir, token, at) => { mkdirSync(dir, { recursive: true }); writeFileSync(ownerFile(dir, token), JSON.stringify({ pid: 1, token, at })) }

test('lock: second acquire fails, release frees, EXPIRED entry is reclaimed deterministically', () => {
  const dir = mkAgent(); const p = join(dir, 'x.lock')
  const a = acquireLock(p, 60_000, 'tok-a')
  assert.ok(a); assert.equal(lockHeld(p), true)
  assert.equal(acquireLock(p, 60_000, 'tok-b'), null, 'second holder must fail while a live entry exists')
  releaseLock(a)
  assert.equal(lockHeld(p), false)

  // Two contenders reclaiming one EXPIRED lock: only ONE may win — the
  // deterministic smallest token. The loser's entry must be withdrawn.
  const staleDir = join(dir, 's.lock')
  writeOwner(staleDir, 'dead-old', new Date(Date.now() - 11 * 60_000).toISOString())
  assert.equal(lockHeld(staleDir), false, 'expired entry is not held')
  const w1 = acquireLock(staleDir, 60_000, 'zz-late')
  assert.ok(w1, 'first contender reclaims the expired lock')
  const w2 = acquireLock(staleDir, 60_000, 'aa-early')
  assert.equal(w2, null, 'second contender loses — no double-hold')
  assert.ok(!existsSync(ownerFile(staleDir, 'aa-early')), 'loser withdraws its entry')
  assert.equal(readLock(staleDir)?.token, 'zz-late')
  releaseLock(w1)

  // Simultaneous fresh entries resolve deterministically: smallest token wins.
  const tieDir = join(dir, 'tie.lock')
  const now = new Date().toISOString()
  writeOwner(tieDir, 'tok-z', now)
  writeOwner(tieDir, 'tok-a', now)
  assert.equal(readLock(tieDir)?.token, 'tok-a', 'deterministic: smallest fresh token holds')
})

test('lock: a zombie holder cannot resurrect over a live successor', () => {
  const dir = mkAgent(); const p = join(dir, 'z.lock')
  const a = acquireLock(p, 60_000, 'token-A')
  assert.ok(a)
  // Takeover: successor wrote its own entry AND is the live winner.
  writeOwner(p, 'token-B', new Date().toISOString())
  writeOwner(p, 'token-A', new Date(Date.now() - 11 * 60_000).toISOString()) // A's own entry went stale
  assert.equal(heartbeatLock(a), false, 'zombie heartbeat reports lost lock')
  assert.equal(readLock(p)?.token, 'token-B', 'successor still holds')
  releaseLock(a) // a no-op for the successor
  assert.equal(readLock(p)?.token, 'token-B', 'successor lock survives zombie release')
})

// ---------- session pinning (fail closed) ----------
test('resolveSession: authoritative pin wins over a newer same-cwd sibling', () => {
  const agent = mkAgent(); const root = join(agent, 'sessions')
  const cwd = 'C:\\repo\\same'
  const pinned = mkSession(root, cwd, '2026-01-01_a.jsonl')
  const sibling = mkSession(root, cwd, '2026-01-02_b.jsonl') // newer — must NOT be chosen
  const r = resolveSession({ pinnedFile: pinned, sessionsRoot: root, cwd })
  assert.equal(r.exact, true); assert.equal(r.path, pinned); assert.equal(r.source, 'pin')
  assert.notEqual(r.path, sibling)
})

test('resolveSession: no pin → scan-only, never exact (two same-cwd sessions)', () => {
  const agent = mkAgent(); const root = join(agent, 'sessions')
  const cwd = 'C:\\repo\\same'
  mkSession(root, cwd, '2026-01-01_a.jsonl')
  mkSession(root, cwd, '2026-01-02_b.jsonl')
  const r = resolveSession({ pinnedFile: null, sessionsRoot: root, cwd })
  assert.equal(r.exact, false); assert.equal(r.source, 'scan')
})

test('resolveSession: pin to a different cwd → none, never falls back to guess', () => {
  const agent = mkAgent(); const root = join(agent, 'sessions')
  const cwd = 'C:\\repo\\same'
  const other = mkSession(root, 'C:\\repo\\other', '2026-01-01_a.jsonl')
  mkSession(root, cwd, '2026-01-03_z.jsonl')
  const r = resolveSession({ pinnedFile: other, sessionsRoot: root, cwd })
  assert.equal(r.exact, false); assert.equal(r.source, 'none')
})

test('resolveSession: pin path that does not exist → scan-only, not exact', () => {
  const agent = mkAgent(); const root = join(agent, 'sessions')
  const cwd = 'C:\\repo\\same'
  mkSession(root, cwd, '2026-01-01_a.jsonl')
  const r = resolveSession({ pinnedFile: join(agent, 'sessions', 'nope', 'missing.jsonl'), sessionsRoot: root, cwd })
  assert.equal(r.exact, false); assert.equal(r.source, 'scan')
})

// Negative regression for the advisory: a single recent same-cwd sibling must
// NOT be treated as the pin just because nothing better was found.
test('resolveSession: only-recent-sibling stays inexact — never inject by recency', () => {
  const agent = mkAgent(); const root = join(agent, 'sessions')
  const cwd = 'C:\\repo\\same'
  const sibling = mkSession(root, cwd, '2026-01-01_a.jsonl')
  utimesSync(sibling, new Date(), new Date()) // freshest possible mtime
  const r = resolveSession({ pinnedFile: null, sessionsRoot: root, cwd })
  assert.equal(r.exact, false, 'a lone recent sibling is not a pin')
  assert.equal(r.source, 'scan')
})
// ---------- driver integration ----------
test('driver: judge failure verdicts failed (stub exits 1), never pass', () => {
  const agent = mkAgent(); const repo = mkRepo()
  const r = runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'error' })
  assert.equal(r.status, 0)
  assert.equal(reviewOf(agent, repo).verdict, 'failed')
})

test('driver: scan-only session → review but NEVER injects (fail closed)', () => {
  const agent = mkAgent(); const repo = mkRepo()
  const root = join(agent, 'sessions')
  mkSession(root, repo, '2026-01-01_a.jsonl'); mkSession(root, repo, '2026-01-02_b.jsonl')
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: true, maxRework: 3 }))
  const r = runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'rework' })
  assert.equal(r.status, 0)
  const review = reviewOf(agent, repo)
  assert.equal(review.verdict, 'rework')
  assert.equal(review.consumed, false, 'un-injected scan-only rework stays unconsumed — nothing may feed it back')
  assert.match(review.summary, /仅评审不注入/)
  // Stub writes orzic-stub-calls.jsonl in agent dir — assert no `-r` call.
  const calls = readFileSync(join(agent, 'orzic-stub-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args)
  assert.ok(calls.every((a) => a[0] !== '-r'), 'no injection without exact session')
})

test('driver: ORZIC_SESSION_FILE pin → rework consumed + -r targets the pinned file', () => {
  const agent = mkAgent(); const repo = mkRepo()
  const root = join(agent, 'sessions')
  mkSession(root, repo, '2026-01-01_a.jsonl')
  const exact = mkSession(root, repo, '2026-01-02_b.jsonl')
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: true, maxRework: 3 }))
  const r = runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_SESSION_FILE: exact, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'rework' })
  assert.equal(r.status, 0)
  const review = reviewOf(agent, repo)
  assert.equal(review.verdict, 'rework')
  assert.equal(review.consumed, true, 'injected rework is consumed')
  const calls = readFileSync(join(agent, 'orzic-stub-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args)
  const injCalls = calls.filter((a) => a[0] === '-r')
  // Revision-dedup: the stub never commits, so HEAD stays the same revision —
  // the same diff must NOT be re-judged/re-injected. One inject, then the next
  // round sees revision already reviewed and stops.
  assert.equal(injCalls.length, 1, 'same revision is not re-injected')
  assert.ok(injCalls.every((a) => a[1] === exact), 'injection targets the pinned session')
})

test('driver: pre-spawn stop flag without a matching token is IGNORED — orphaned flag can never abort a new run', () => {
  const agent = mkAgent(); const repo = mkRepo()
  const root = join(agent, 'sessions')
  const exact = mkSession(root, repo, '2026-01-01_a.jsonl')
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: true, maxRework: 3 }))
  writeFileSync(join(agent, `orzic-stop-${keyOf(repo)}`), '{}') // stale flag, no token
  const r = runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_SESSION_FILE: exact, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'rework' })
  assert.equal(r.status, 0)
  const review = reviewOf(agent, repo)
  assert.notEqual(review.verdict, 'unreviewed', 'stale flag must not abort the new run')
})

test('driver: cooperative stop with matching token → exits with unreviewed, lock released', async () => {
  const agent = mkAgent(); const repo = mkRepo()
  const root = join(agent, 'sessions')
  const exact = mkSession(root, repo, '2026-01-01_a.jsonl')
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: true, maxRework: 3 }))
  const key = keyOf(repo)
  const child = spawn(NODE, [DRIVER], { env: { ...process.env, ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_SESSION_FILE: exact, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'rework' }, stdio: 'pipe' })
  // Wait for the lock to appear, then read the run token the driver minted.
  const lockPath = join(agent, `orzic-driver-${key}.lock`)
  let token = ''
  for (let i = 0; i < 100 && !token; i++) {
    try { token = readLock(lockPath)?.token ?? '' } catch { /* not yet */ }
    if (!token) await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(token, 'driver wrote a run token into its lock')
  writeFileSync(join(agent, `orzic-stop-${key}`), JSON.stringify({ at: new Date().toISOString(), token }))
  const status = await new Promise((r) => child.on('exit', r))
  assert.equal(status, 0)
  const review = reviewOf(agent, repo)
  assert.equal(review.verdict, 'unreviewed')
  assert.match(review.summary, /手动停止/)
  assert.equal(lockHeld(lockPath), false, 'driver released its own lock')
})

test('driver: force kill with matching token → kills the in-flight omp -r child, exits, lock released', async () => {
  const agent = mkAgent(); const repo = mkRepo()
  const root = join(agent, 'sessions')
  const exact = mkSession(root, repo, '2026-01-01_a.jsonl')
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: true, maxRework: 3 }))
  const key = keyOf(repo)
  const child = spawn(NODE, [DRIVER], { env: { ...process.env, ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_SESSION_FILE: exact, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'rework' }, stdio: 'pipe' })
  const lockPath = join(agent, `orzic-driver-${key}.lock`)
  let token = ''
  for (let i = 0; i < 100 && !token; i++) {
    try { token = readLock(lockPath)?.token ?? '' } catch { /* not yet */ }
    if (!token) await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(token)
  // Land the kill while the driver is (or will be) inside `omp -r`.
  writeFileSync(join(agent, `orzic-stop-${key}`), JSON.stringify({ at: new Date().toISOString(), token, kill: true }))
  const status = await new Promise((r) => child.on('exit', r))
  assert.equal(status, 0)
  assert.match(reviewOf(agent, repo).summary, /强杀/)
  assert.equal(lockHeld(lockPath), false, 'force-stopped driver released its lock')
})

test('driver: stop arriving mid-run (during omp -r) → next round exits, no more injects', () => {
  const agent = mkAgent(); const repo = mkRepo()
  const root = join(agent, 'sessions')
  const exact = mkSession(root, repo, '2026-01-01_a.jsonl')
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: true, maxRework: 3 }))
  const r = runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_SESSION_FILE: exact, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'rework', ORZIC_STUB_STOP_ON_INJECT: 'stop' })
  assert.equal(r.status, 0)
  const review = reviewOf(agent, repo)
  assert.equal(review.verdict, 'unreviewed')
  assert.match(review.summary, /手动停止/)
  const calls = readFileSync(join(agent, 'orzic-stub-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args)
  const injCalls = calls.filter((a) => a[0] === '-r')
  assert.equal(injCalls.length, 1, 'only the first inject ran — no post-stop inject')
})

test('driver: force kill with a detached grandchild in flight → the WHOLE tree dies', async () => {
  const agent = mkAgent(); const repo = mkRepo()
  const root = join(agent, 'sessions')
  const exact = mkSession(root, repo, '2026-01-01_a.jsonl')
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: true, maxRework: 3 }))
  const key = keyOf(repo)
  const child = spawn(NODE, [DRIVER], { env: { ...process.env, ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_SESSION_FILE: exact, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'rework', ORZIC_STUB_GRANDCHILD: '1', ORZIC_STUB_SLEEP_MS: '60000' }, stdio: 'pipe' })
  const lockPath = join(agent, `orzic-driver-${key}.lock`)
  // Wait until the stub has spawned its grandchild (the `-r` ran), then force-kill.
  let token = '', gpid = 0
  for (let i = 0; i < 120 && (!token || !gpid); i++) {
    try { token = readLock(lockPath)?.token ?? '' } catch { /* not yet */ }
    try { gpid = parseInt(readFileSync(join(agent, 'orzic-grandchild.pid'), 'utf8'), 10) || 0 } catch { /* not yet */ }
    if (!token || !gpid) await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(token, 'driver lock carries a run token')
  assert.ok(gpid > 0, 'stub grandchild is running')
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  assert.ok(alive(gpid), 'grandchild alive before force')
  writeFileSync(join(agent, `orzic-stop-${key}`), JSON.stringify({ at: new Date().toISOString(), token, kill: true }))
  const status = await new Promise((r) => child.on('exit', r))
  assert.equal(status, 0)
  assert.match(reviewOf(agent, repo).summary, /强杀/)
  // The grandchild — a node process the driver never saw — must be dead too.
  assert.equal(alive(gpid), false, `grandchild pid ${gpid} must be dead, not just the driver`)
})

test('driver: second instance exits immediately when lock held', () => {
  const agent = mkAgent(); const repo = mkRepo()
  const holder = acquireLock(join(agent, `orzic-driver-${keyOf(repo)}.lock`))
  const r = runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]) }, 15_000)
  releaseLock(holder)
  assert.equal(r.status, 0)
  assert.match(readFileSync(join(agent, `orzic-driver-${keyOf(repo)}.log`), 'utf8'), /another driver holds the lock/)
})

test('driver: no-diff run does NOT downgrade an existing verdict', () => {
  const agent = mkAgent()
  const repo = mkRepo()
  // An empty HEAD commit → `git diff HEAD^..HEAD` is empty (chat-only turn).
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'empty'], { cwd: repo, stdio: 'pipe' })
  const root = join(agent, 'sessions')
  const exact = mkSession(root, repo, '2026-01-01_a.jsonl')
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: true, maxRework: 3 }))
  writeFileSync(join(agent, `orzic-review-${keyOf(repo)}.json`), JSON.stringify({ at: '2026-01-01', verdict: 'pass', findings: [], summary: '0 findings', round: 1 }))
  const r = runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_SESSION_FILE: exact, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'rework' })
  assert.equal(r.status, 0, `status ${r.status} err ${r.error?.message} stderr ${r.stderr?.slice(0, 300)}`)
  const dlog = existsSync(join(agent, `orzic-driver-${keyOf(repo)}.log`)) ? readFileSync(join(agent, `orzic-driver-${keyOf(repo)}.log`), 'utf8') : 'no-log'
  const raw = readFileSync(join(agent, `orzic-review-${keyOf(repo)}.json`), 'utf8')
  assert.equal(reviewOf(agent, repo).verdict, 'pass', `empty diff must not overwrite the last verdict\nlog:${dlog}\nreview.json:${raw}`)
})

test('driver: two repos run concurrently — separate lock/review/stop namespaces', () => {
  const agent = mkAgent()
  const repoA = mkRepo(); const repoB = mkRepo()
  const root = join(agent, 'sessions')
  mkSession(root, repoA, '2026-01-01_a.jsonl')
  const sB = mkSession(root, repoB, '2026-01-01_b.jsonl')
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: true, maxRework: 3 }))
  // Hold A's lock — B must still run; each writes its own verdict file.
  const holder = acquireLock(join(agent, `orzic-driver-${keyOf(repoA)}.lock`))
  const r = runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repoB, ORZIC_SESSION_FILE: sB, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'pass' })
  releaseLock(holder)
  assert.equal(r.status, 0)
  assert.equal(reviewOf(agent, repoB).verdict, 'pass', 'repo B judged despite repo A lock held')
  assert.equal(existsSync(join(agent, `orzic-review-${keyOf(repoA)}.json`)), false, 'repo A untouched')
  // A stop flag for repo A must not stop repo B.
  writeFileSync(join(agent, `orzic-stop-${keyOf(repoA)}`), '{}')
  const r2 = runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repoB, ORZIC_SESSION_FILE: sB, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'pass' })
  assert.equal(r2.status, 0)
  assert.equal(reviewOf(agent, repoB).verdict, 'pass', 'repo A stop flag does not stop repo B')
})

test('repoKey: real directories must never collide', () => {
  const base = mkdtempSync(join(tmpdir(), 'orzic-key-'))
  const keys = (a, b) => [keyOf(a), keyOf(b)]
  if (process.platform !== 'win32') {
    // POSIX: 'a\b' is a LITERAL directory name containing a backslash — a
    // Windows-style separator fold would collide it with 'a/b'.
    mkdirSync(join(base, 'a\\b'), { recursive: true }) // /base/a\b  (one dir)
    mkdirSync(join(base, 'a', 'b'), { recursive: true }) // /base/a/b  (nested)
    const [ka, kb] = keys(join(base, 'a\\b'), join(base, 'a', 'b'))
    assert.notEqual(ka, kb, 'POSIX /a\\b vs /a/b must not share a lock/verdict/stop')
  } else {
    // Windows: two spellings of one real path (case/trailing slash) → same key;
    // different real paths → different keys even if the old naive slug collided.
    mkdirSync(join(base, 'a-b'), { recursive: true })
    mkdirSync(join(base, 'a', 'b'), { recursive: true })
    const [ka, kb] = keys(join(base, 'a-b'), join(base, 'a', 'b'))
    assert.notEqual(ka, kb, 'C:\\…\\a-b vs C:\\…\\a\\b must not collide')
    assert.equal(keyOf(join(base, 'a-b').toLowerCase() + '\\'), keyOf(join(base, 'a-b')), 'same dir, different spelling → same key')
  }
})

test('driver: revision dedup — two launches, same HEAD, judge called exactly once', () => {
  const agent = mkAgent(); const repo = mkRepo()
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: true, maxRework: 3 }))
  const env = { ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'pass' }
  assert.equal(runDriver(env).status, 0)
  assert.equal(runDriver(env).status, 0, 'second launch on same HEAD')
  const calls = readFileSync(join(agent, 'orzic-stub-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args)
  const judgeCalls = calls.filter((a) => a[0] === '--model')
  assert.equal(judgeCalls.length, 1, 'same revision+model+rules → judge not re-run')
  const review = reviewOf(agent, repo)
  assert.ok(review.dedupKey, 'verdict carries dedup key')
})

test('driver: deterministic gate — failing checkCmd returns rework WITHOUT calling the judge', () => {
  const agent = mkAgent(); const repo = mkRepo()
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: false, maxRework: 3, checkCmd: 'exit 1' }))
  const r = runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'pass' })
  assert.equal(r.status, 0)
  const review = reviewOf(agent, repo)
  assert.equal(review.verdict, 'rework', 'failing check must yield rework')
  assert.match(review.summary, /check 失败/)
  // The paid judge was never invoked — the gate short-circuited.
  const calls = existsSync(join(agent, 'orzic-stub-calls.jsonl')) ? readFileSync(join(agent, 'orzic-stub-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).args) : []
  assert.equal(calls.filter((a) => a[0] === '--model').length, 0, 'judge not called when check fails')
})

test('driver: passing checkCmd proceeds to the judge', () => {
  const agent = mkAgent(); const repo = mkRepo()
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: false, maxRework: 3, checkCmd: 'exit 0' }))
  const r = runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'pass' })
  assert.equal(r.status, 0)
  assert.equal(reviewOf(agent, repo).verdict, 'pass')
  const calls = readFileSync(join(agent, 'orzic-stub-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args)
  assert.equal(calls.filter((a) => a[0] === '--model').length, 1, 'passing check → judge runs once')
})

test('driver: a newly configured failing gate is NOT bypassed by an old PASS on unchanged HEAD', () => {
  const agent = mkAgent(); const repo = mkRepo()
  // Round 1: no gate, judge returns pass.
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: false, maxRework: 3 }))
  assert.equal(runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'pass' }).status, 0)
  assert.equal(reviewOf(agent, repo).verdict, 'pass')
  // Round 2: SAME HEAD, now a failing checkCmd is configured → must rework, not reuse the PASS.
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: false, maxRework: 3, checkCmd: 'exit 1' }))
  assert.equal(runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'pass' }).status, 0)
  assert.equal(reviewOf(agent, repo).verdict, 'rework', 'old PASS must not bypass a new failing gate')
  // Still only ONE judge call ever — the gate rework never paid for a second.
  const calls = readFileSync(join(agent, 'orzic-stub-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args)
  assert.equal(calls.filter((a) => a[0] === '--model').length, 1, 'gate rework adds no second judge call')
})

test('driver: failing gate + exact pin + autoRework actually emits one `omp -r` inject', () => {
  const agent = mkAgent(); const repo = mkRepo()
  const root = join(agent, 'sessions'); mkdirSync(root, { recursive: true })
  const exact = mkSession(root, repo, '2026-01-03_b.jsonl')
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: true, maxRework: 3, checkCmd: 'exit 1' }))
  const r = runDriver({ ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_SESSION_FILE: exact, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'rework' })
  assert.equal(r.status, 0)
  const review = reviewOf(agent, repo)
  assert.equal(review.kind, 'gate')
  assert.equal(review.gateKey.includes('exit 1'), true)
  assert.equal(review.consumed, true, 'first gate failure is consumed after injection')
  const calls = readFileSync(join(agent, 'orzic-stub-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args)
  const injCalls = calls.filter((a) => a[0] === '-r')
  assert.equal(injCalls.length, 1, 'failing gate emits exactly one `omp -r` rework inject')
  assert.equal(injCalls[0][1], exact, 'injection targets the pinned session')
  assert.equal(calls.filter((a) => a[0] === '--model').length, 0, 'judge still never called')
})

test('driver: unchanged revision + same failing gate injects only once across relaunches', () => {
  const agent = mkAgent(); const repo = mkRepo()
  const root = join(agent, 'sessions'); mkdirSync(root, { recursive: true })
  const exact = mkSession(root, repo, '2026-01-03_c.jsonl')
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: true, maxRework: 3, checkCmd: 'exit 1' }))
  const env = { ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_SESSION_FILE: exact, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'rework' }
  assert.equal(runDriver(env).status, 0)
  assert.equal(runDriver(env).status, 0, 'same failing gate on relaunch must stop without another inject')
  const calls = readFileSync(join(agent, 'orzic-stub-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args)
  assert.equal(calls.filter((a) => a[0] === '-r').length, 1, 'same revision + same gate error injects once')
  assert.equal(reviewOf(agent, repo).kind, 'gate')
})

test('driver: recovered gate ignores old gate rework and runs the judge', () => {
  const agent = mkAgent(); const repo = mkRepo()
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: false, maxRework: 3, checkCmd: 'exit 1' }))
  const env = { ORZIC_AGENT_DIR: agent, ORZIC_CWD: repo, ORZIC_OMP_BIN: NODE, ORZIC_OMP_PREARGS: JSON.stringify([STUB]), ORZIC_STUB_MODE: 'pass' }
  assert.equal(runDriver(env).status, 0)
  assert.equal(reviewOf(agent, repo).kind, 'gate')
  writeFileSync(join(agent, 'orzic-acceptance.json'), JSON.stringify({ autoReview: true, autoRework: false, maxRework: 3, checkCmd: 'exit 0' }))
  assert.equal(runDriver(env).status, 0)
  const review = reviewOf(agent, repo)
  assert.equal(review.kind, 'judge', 'a passing gate must replace old gate rework with a judge result')
  assert.equal(review.verdict, 'pass')
  const calls = readFileSync(join(agent, 'orzic-stub-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args)
  assert.equal(calls.filter((a) => a[0] === '--model').length, 1, 'recovered gate invokes judge once')
})
