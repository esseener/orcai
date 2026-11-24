// Orzic loop driver — detached node process spawned by the orzic-loop
// extension's agent_end. Runs OUTSIDE the Bun omp process, so execFile('omp')
// does not hang. Loop: git diff → nested omp judge → REWORK re-injects a new
// turn via `omp -r <sessionFile>` (with ORZIC_DRIVER=1 so the resumed session's
// own agent_end does not spawn another driver). Verdict always lands in
// ~/.omp/agent/orzic-review.json for the Orca side panel.
//
// Safety rules:
// - Single instance: orzic-driver.lock (wx + mtime heartbeat).
// - Fail closed on session pinning: `omp -r` only runs when agent_end's
//   pending file gives an exact session path/id. A cwd-substring scan can hit
//   a sibling session in the same repo — scan hits are review-only.
// - consumed flag: review.json is marked consumed BEFORE injecting so the
//   prompt_submit path never double-injects.
// - Failure is never a pass: judge/inject/diff errors write verdict 'failed'.

import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { verdictFromOutput } from './orzic-verdict.mjs'
import { acquireLock, heartbeatLock, releaseLock } from './orzic-lock.mjs'
import { resolveSession } from './orzic-session.mjs'
import { repoKey } from './orzic-repokey.mjs'
// Test seams: ORZIC_AGENT_DIR redirects all state; ORZIC_OMP_BIN + ORZIC_OMP_PREARGS
// (JSON array) replace the omp binary (e.g. node + stub.mjs). Prod never sets them.
const AGENT = process.env.ORZIC_AGENT_DIR || join(homedir(), '.omp', 'agent')
const cwd = process.env.ORZIC_CWD || process.cwd()
// Per-repo state files — the key mixes a readable basename with a SHA-256 of
// the normalized real path, so C:\tmp\a-b and C:\tmp\a\b can't collide.
// repoKey MUST stay in sync with repoKeyFor in repokey.ts (panel/loop side).
const KEY = repoKey(cwd)
const REVIEW = join(AGENT, `orzic-review-${KEY}.json`)
const PLAN = join(AGENT, `orzic-plan-${KEY}.json`)
const LOG = join(AGENT, `orzic-driver-${KEY}.log`)
const CFG = join(AGENT, 'orzic-acceptance.json')
const LOCK = join(AGENT, `orzic-driver-${KEY}.lock`)
const STOP = join(AGENT, `orzic-stop-${KEY}`)
const OMP = process.env.ORZIC_OMP_BIN || process.env.OMP_CLI_COMMAND || 'omp'
const OMP_PRE = (() => { try { const v = JSON.parse(process.env.ORZIC_OMP_PREARGS || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } })()
const log = (m) => { try { mkdirSync(AGENT, { recursive: true }); writeFileSync(LOG, `${new Date().toISOString()} ${m}\n`, { flag: 'a' }) } catch {} }
const writeReview = (r) => { try { writeFileSync(REVIEW, JSON.stringify(r, null, 2), 'utf8') } catch {} }

// Config is re-read every round — fusion.set changes apply mid-loop.
const readAcc = () => {
  try {
    const d = JSON.parse(readFileSync(CFG, 'utf8'))
    return {
      ocr: d.ocr === true, ocrModel: typeof d.ocrModel === 'string' ? d.ocrModel : null,
      ocrEffort: typeof d.ocrEffort === 'string' ? d.ocrEffort : null,
      rulePath: typeof d.rulePath === 'string' ? d.rulePath : null,
      checkCmd: typeof d.checkCmd === 'string' ? d.checkCmd.trim() : '',
      autoReview: d.autoReview === true, autoRework: d.autoRework === true,
      maxRework: typeof d.maxRework === 'number' && d.maxRework > 0 ? d.maxRework : 3,
    }
  } catch {
    return { ocr: false, ocrModel: null, ocrEffort: null, rulePath: null, autoReview: false, autoRework: false, maxRework: 3, checkCmd: '' }
  }
}

// Deterministic gate — free, deterministic checks run BEFORE the paid AI
// judge (Devin fusion: sidekick runs builds/tests; AWS gated review: hard
// checks first). `acc.checkCmd` is a shell command run in the repo; a failure
// returns its output so the driver can REWORK without spending a judge call.
const runCheck = (cmd, timeout = 120_000) => new Promise((res) => {
  execFile(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd], { encoding: 'utf8', cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (e, out, serr) => {
    res({ out: `${out || ''}${serr ? `\n${serr}` : ''}`, err: e ? (serr || String(e)).slice(0, 400) : null })
  })
})

const run = (args, timeout) => new Promise((res) => {
  // spawn (not execFile): POSIX `detached` only applies to spawn — the child
  // gets its own process group so `kill(-pid)` really reaches the whole tree.
  const c = spawn(OMP, [...OMP_PRE, ...args], { detached: process.platform !== 'win32', cwd, windowsHide: true, env: { ...process.env, ORZIC_DRIVER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  currentChild = c // tracked so forceExit can kill the in-flight `omp -r`, never a recycled pid
  // `close` (stdio drained) can lag `exit` when a descendant holds the pipes —
  // clear on `exit`, the moment Node releases the OS handle and the pid is free.
  c.on('exit', () => { if (currentChild === c) currentChild = null })
  let out = '', serr = ''
  c.stdout.on('data', (d) => { out += d })
  c.stderr.on('data', (d) => { serr += d })
  const timer = setTimeout(() => { killTree(c) }, timeout)
  c.on('error', (e) => { clearTimeout(timer); res({ out, err: String(e).slice(0, 300) }) })
  c.on('close', (code, signal) => { clearTimeout(timer); if (currentChild === c) currentChild = null; res({ out, err: code === 0 ? null : (serr || `exit ${code ?? signal ?? '?'}`).slice(0, 300) }) })
})

// Mirrors acceptance.ts gitDiff: distinguish a valid empty diff (empty commit /
// no changes -> review-only '无 diff') from a real git error ('failed'), and use
// `git show` ONLY when HEAD is the root commit — never as an error fallback.
const git = (args) => new Promise((res) => {
  execFile('git', args, { encoding: 'utf8', cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (e, out, stderr) => {
    res({ out: out || '', err: e ? (stderr || String(e)).slice(0, 200) : null })
  })
})

const gitHead = () => git(['rev-parse', 'HEAD'])

// Diff for the CAPTURED sha — never re-resolve live HEAD (a commit landing
// between rev-parse and diff would otherwise review B while recording A).
const gitDiffAt = async (sha) => {
  const c = await git(['rev-list', '--count', sha])
  if (c.err) return { out: '', err: c.err }
  if (c.out.trim() === '1') return git(['show', sha, '--format='])
  return git(['diff', `${sha}~1..${sha}`])
}

const ruleFor = (acc) => {
  if (!acc.rulePath) return '检查常见缺陷:空输入、除零、未捕获错误、边界、注入'
  try {
    const d = JSON.parse(readFileSync(join(cwd, acc.rulePath), 'utf8'))
    return (d.rules ?? []).map((r) => r.rule).filter(Boolean).join(';') || '检查常见缺陷'
  } catch { return '检查常见缺陷' }
}

const planFor = () => {
  try {
    const d = JSON.parse(readFileSync(PLAN, 'utf8'))
    if (!d || d.approved !== true || typeof d.planContent !== 'string') return { text: '', digest: 'none' }
    const pinned = process.env.ORZIC_SESSION_FILE || ''
    if (!pinned || d.sessionFile !== pinned) return { text: '', digest: 'unpinned' }
    return { text: d.planContent.slice(0, 20000), digest: String(d.digest || 'nodigest') }
  } catch { return { text: '', digest: 'none' } }
}

const judgeModel = (acc) => acc.ocrModel || '@default'
const judge = async (diff, acc, plan) => {
  const model = judgeModel(acc)
  const planBlock = plan.text ? `\n已批准的计划(实现须与之一致,偏离即 finding):\n${plan.text}\n` : ''
  const prompt = `你是代码验收评审。按规则审以下 git diff,只输出 JSON(无其他文字):{"verdict":"pass|rework","findings":[{"severity":"low|medium|high|blocker","file":"","line":0,"message":""}]}。规则:${ruleFor(acc)}${planBlock}\ndiff:\n${diff.slice(0, 120000)}`
  const { out, err } = await run(['--model', model, '--mode', 'json', '--no-session', '--no-extensions', '--no-prewalk', prompt], 280_000)
  return verdictFromOutput(out, { error: err, model })
}

// --- Single instance + per-run token ----------------------------------------
// A recycled PID can never be trusted: force-stop is delivered to the OWNING
// driver via a token only it knows, never by trusting the lock's pid field.
const RUN_TOKEN = randomUUID()
const lock = acquireLock(LOCK, 10 * 60_000, RUN_TOKEN)
if (!lock) { log('another driver holds the lock — exiting'); process.exit(0) }

// The `omp` child currently in flight, if any — only this driver may kill it.
let currentChild = null
const killTree = (child) => {
  // Never taskkill a pid Node has already released: exitCode/signalCode set
  // means the OS handle is gone and the number may have been recycled.
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    // taskkill /T walks the whole process tree on Windows (verified: detached
    // grandchildren die too); on POSIX the detached spawn gave the child its
    // own process group, so kill(-pid) reaches every member of the subtree.
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'pipe' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch { /* already gone */ }
}

let stopRequested = false
const forceExit = (reason) => {
  try { if (currentChild) killTree(currentChild) } catch { /* best-effort */ }
  writeReview({ at: new Date().toISOString(), verdict: 'unreviewed', findings: [], summary: `${reason}(第${round}轮)`, round })
  log(reason)
  releaseLock(lock)
  process.exit(0)
}
const checkStop = () => {
  let d = null
  try { d = JSON.parse(readFileSync(STOP, 'utf8')) } catch { return }
  if (!d || typeof d !== 'object') return
  if (d.token !== RUN_TOKEN) return // stale/orphaned flag — not ours
  if (d.kill === true) forceExit('已强杀')
  else stopRequested = true
}
const stopWatch = setInterval(checkStop, 400)

const sessionInfo = resolveSession({ pinnedFile: process.env.ORZIC_SESSION_FILE || null, sessionsRoot: join(AGENT, 'sessions'), cwd })
log(`driver start cwd=${cwd} session=${sessionInfo.path} exact=${sessionInfo.exact} src=${sessionInfo.source}`)
let round = 0
try {
  while (true) {
    if (!heartbeatLock(lock)) { log('lock lost (another driver took over) — exit'); break } // zombie revival must not keep running
    checkStop() // synchronous per-round check — catches a stop written between interval ticks
    if (stopRequested) { writeReview({ at: new Date().toISOString(), verdict: 'unreviewed', findings: [], summary: `已手动停止(第${round}轮)`, round }); log(`stop flag — exit after round ${round}`); break }
    const acc = readAcc()
    const head = await gitHead()
    const sha = head.out?.trim() || ''
    // Dedup key = revision + reviewer model + rule text + the GATE command —
    // a new/changed checkCmd is a different review, so an old PASS can never
    // bypass a freshly configured failing gate.
    const plan = planFor()
    const dedupKey = sha ? `${sha}@@${judgeModel(acc)}@@${ruleFor(acc)}@@${acc.checkCmd || ''}@@${plan.digest}` : ''
    const prev = (() => { try { return JSON.parse(readFileSync(REVIEW, 'utf8')) } catch { return null } })()
    // Deterministic gate BEFORE dedup AND before the paid judge: a gate is a
    // fresh review surface, so it must run even when the revision was already
    // AI-reviewed — an old PASS must not skip a newly configured gate. A gate
    // finding is a `rework` verdict, never an AI `pass`, and is never cached as one.
    let review
    let reviewKind = 'judge'
    let gateKey = ''
    if (acc.checkCmd) {
      const chk = await runCheck(acc.checkCmd)
      if (chk.err) {
        gateKey = `${sha}@@${acc.checkCmd}@@${chk.err}`
        if (prev?.kind === 'gate' && prev.gateKey === gateKey && prev.verdict === 'rework') {
          log(`skip: ${sha.slice(0, 10)} gate still failing with the same error — no duplicate inject`)
          break
        }
        reviewKind = 'gate'
        review = { verdict: 'rework', findings: [{ severity: 'high', file: '(check)', line: null, message: chk.err.slice(0, 400) }], summary: `check 失败:${acc.checkCmd.slice(0, 60)}` }
        log(`check failed → rework without judge: ${chk.err.slice(0, 120)}`)
      } else {
        log('check passed')
      }
    }
    if (!review && dedupKey && prev?.kind === 'judge' && prev.dedupKey === dedupKey && prev.verdict && prev.verdict !== 'unreviewed' && prev.verdict !== 'failed') {
      log(`skip: ${sha.slice(0, 10)} already reviewed → ${prev.verdict}`); break
    }
    if (!review) {
      const diff = await gitDiffAt(sha)
      if (diff.err) { writeReview({ at: new Date().toISOString(), verdict: 'failed', findings: [], summary: `git diff 失败:${diff.err}` }); log(`git diff failed ${diff.err}`); break }
      if (!diff.out.trim()) { if (!existsSync(REVIEW)) writeReview({ at: new Date().toISOString(), verdict: 'unreviewed', findings: [], summary: '无 diff', revision: sha || undefined, dedupKey: dedupKey || undefined }); log('no diff'); break }
      review = await judge(diff.out, acc, plan)
    }


  // Fail closed: injection requires BOTH a rework verdict and an exact pin.
  // Decide `consumed` BEFORE writing — never publish an unconsumed rework
  // verdict; a stale reader (or a sibling session's prompt) must never see a
  // transient state that looks feedable.
  const canInject = acc.autoRework && round < acc.maxRework && sessionInfo.exact && sessionInfo.path
  const willInject = review.verdict === 'rework' && canInject
  const capped = review.verdict === 'rework' && acc.autoRework && sessionInfo.exact && round >= acc.maxRework
  const note = review.verdict !== 'rework' ? ''
    : willInject ? ''
    : capped ? `(返工已达上限 ${acc.maxRework} 轮)`
    : !sessionInfo.exact ? '(无精确 session,已仅评审不注入)'
    : !acc.autoRework ? '(autoRework 未启用)' : ''
  writeReview({ ...review, kind: reviewKind, ...(gateKey ? { gateKey } : {}), round, consumed: Boolean(willInject) || capped, revision: sha || undefined, dedupKey: reviewKind === 'judge' ? (dedupKey || undefined) : undefined, ...(note ? { summary: `${review.summary}${note}` } : {}) })
  log(`round ${round} verdict=${review.verdict} findings=${review.findings.length}${capped ? ' cap-consumed' : ''}${note ? ` ${note}` : ''}`)
  if (!willInject) break

  round++
  const findings = review.findings.slice(0, 10).map((f) => `- [${f.severity}] ${f.file}${f.line != null ? `:${f.line}` : ''} ${f.message}`).join('\n')
  const msg = `验收未通过(REWORK,第${round}轮)。按以下 findings 返工:\n${findings}\n\n要求:修复后自检,确保不再触发同类问题。`
  const inj = await run(['-r', sessionInfo.path, '--model', '@default', '--mode', 'json', msg], 600_000)
  if (!heartbeatLock(lock)) { log('lock lost — exit'); break }
  if (inj.err) {
    writeReview({ at: new Date().toISOString(), verdict: 'failed', findings: review.findings, summary: `REWORK 注入失败:${inj.err.slice(0, 150)}`, round })
    log(`inject round ${round} failed: ${inj.err}`)
    break
  }
  log(`inject round ${round} ok`)
  }
} finally {
  clearInterval(stopWatch)
  releaseLock(lock)
}
log('driver done')
