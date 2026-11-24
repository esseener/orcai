// Session pinning for the orzic driver — fail closed.
// A rework injection goes to `omp -r <file>`; injecting into the WRONG session
// is worse than not injecting. There is exactly one authoritative pin: the
// session file that OMP's live hooks (before_agent_start/agent_start/tool_call)
// expose via ctx.sessionManager.getSessionFile(), handed to the driver as
// ORZIC_SESSION_FILE. Anything inferred from the filesystem (cwd match, mtime,
// newest file) can collide with a sibling session in the same repo — so those
// are ONLY used to prove a session exists, never to pick one.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {object} o
 * @param {string|null} o.pinnedFile  ORZIC_SESSION_FILE — authoritative path from ctx.sessionManager.
 * @param {string} o.sessionsRoot     ~/.omp/agent/sessions
 * @param {string} o.cwd              the repo cwd this run belongs to
 * @returns {{ path: string|null, exact: boolean, source: 'pin'|'scan'|'none' }}
 * exact=true  ⇒ safe to `omp -r`; exact=false ⇒ review-only, never inject.
 */
export function resolveSession({ pinnedFile, sessionsRoot, cwd }) {
  // 1. Authoritative pin from ctx.sessionManager. It must exist AND belong to
  //    this cwd — a stale/wrong file is not better than nothing.
  if (pinnedFile && existsSync(pinnedFile)) {
    if (sameCwdFile(pinnedFile, cwd)) return { path: pinnedFile, exact: true, source: 'pin' }
    // Pinned to a different cwd → don't trust it, don't fall through to a
    // same-cwd guess either (the pin said which session; it just isn't ours).
    return { path: null, exact: false, source: 'none' }
  }

  // 2. Filesystem scan proves A session exists — but cannot prove WHICH one.
  const scanned = scanNewest(sessionsRoot, cwd)
  return scanned ? { path: scanned, exact: false, source: 'scan' } : { path: null, exact: false, source: 'none' }
}

// A substring match is not enough: `C:\repo\app` is a prefix of
// `C:\repo\app-other`. Parse the session header and compare normalized paths.
// Backslash is a legal POSIX filename character, so only Windows-style paths
// get separator normalization; folding it on POSIX would equate /a\b with /a/b
// and let a session from another directory pass the exact-pin check.
export function normalizePath(value) {
  let p = String(value ?? '').trim()
  if (!p) return ''
  try { p = realpathSync(p) } catch { /* path may not exist; keep the header value */ }
  const windows = process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
  if (windows) {
    p = p.replace(/\\/g, '/')
    if (/^[a-zA-Z]:\//.test(p) || p.startsWith('//')) p = p.toLowerCase()
  }
  return p.replace(/\/+$/, '')
}

function sessionCwd(file) {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 8000)
    for (const line of head.split('\n')) {
      if (!line.trim()) continue
      try {
        const d = JSON.parse(line)
        if (d?.type === 'session' && typeof d.cwd === 'string') return d.cwd
      } catch { /* skip partial/non-session lines */ }
    }
  } catch { /* unreadable */ }
  return ''
}

function sameCwdFile(file, cwd) {
  const want = normalizePath(cwd)
  const got = normalizePath(sessionCwd(file))
  return Boolean(want && got && want === got)
}

function scanNewest(sessionsRoot, cwd) {
  try {
    let best = null, bestM = 0
    for (const dir of readdirSync(sessionsRoot)) {
      const dp = join(sessionsRoot, dir)
      let files = []
      try { files = readdirSync(dp) } catch { continue }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const fp = join(dp, f)
        if (!sameCwdFile(fp, cwd)) continue
        const m = statSync(fp).mtimeMs
        if (m > bestM) { bestM = m; best = fp }
      }
    }
    return best
  } catch { return null }
}
