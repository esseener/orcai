// Single-instance lock for the orzic driver — directory-based, atomic.
//
// `lock` is a DIRECTORY. Every contender writes its OWN `owner-<token>.json`
// inside it: unique filename -> no shared mutable file, so there is no
// check-then-mutate window (mkdir + a per-owner entry are the only mutators).
// The live holder = the fresh entry with the smallest token — deterministic,
// so simultaneous contenders always agree on ONE winner.
// Freshness lives in the entry payload (`at`), refreshed by heartbeatLock —
// file mtime is never consulted, so "is it alive" can't be fooled by mtime
// races or utimes tricks.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LOCK_STALE_MS = 10 * 60_000

const safe = (s) => String(s).replace(/[^\w.-]/g, '_')
const entryName = (token) => `owner-${safe(token)}.json`

const fresh = (at, staleMs) => {
  const t = Date.parse(at)
  return Number.isFinite(t) && Date.now() - t < staleMs
}

/** All well-formed owner entries, newest-ish. Malformed ones are ignored. */
const entries = (path, staleMs = LOCK_STALE_MS) => {
  try {
    const out = []
    for (const f of readdirSync(path)) {
      if (!f.startsWith('owner-') || !f.endsWith('.json')) continue
      try {
        const d = JSON.parse(readFileSync(join(path, f), 'utf8'))
        if (typeof d?.token === 'string' && d.token) {
          out.push({ file: join(path, f), token: d.token, pid: d.pid ?? 0, at: String(d.at ?? ''), fresh: fresh(d.at, staleMs) })
        }
      } catch { /* skip */ }
    }
    return out
  } catch { return [] }
}

/** The live holder = fresh entry with the smallest token (deterministic). */
const winner = (path, staleMs = LOCK_STALE_MS) => {
  const live = entries(path, staleMs).filter((e) => e.fresh).sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0))
  return live[0] ?? null
}

/**
 * Try to take the lock. `token` is a caller-chosen run secret stored in the
 * entry — the panel relays it back in a stop request so only the OWNING run
 * accepts a force-stop, never a recycled pid. Returns {path,pid,secret} or null.
 *
 * Protocol: see any fresh holder -> refuse. Otherwise create my own entry and
 * re-check; if a simultaneous contender won the deterministic race, withdraw
 * my entry and lose. Owner-specific entries mean I NEVER touch another
 * holder's file — the old stat->unlink takeover race is gone.
 */
export function acquireLock(path, staleMs = LOCK_STALE_MS, token = '') {
  const secret = token || String(process.pid)
  if (winner(path, staleMs)) return null
  try {
    // Backward compat: a legacy lock FILE (pre-directory locking) may sit here.
    // Only a stale one is removed — a fresh legacy file still means "held".
    if (existsSync(path) && statSync(path).isFile()) {
      if (Date.now() - statSync(path).mtimeMs < staleMs) return null
      unlinkSync(path)
    }
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, entryName(secret)), JSON.stringify({ pid: process.pid, token: secret, at: new Date().toISOString() }))
  } catch { return null }
  const w = winner(path, staleMs)
  if (w?.token !== secret) {
    try { unlinkSync(join(path, entryName(secret))) } catch { /* withdraw */ }
    return null
  }
  return { path, pid: process.pid, secret }
}

/** Refresh MY entry's `at` — and ONLY if I still hold the lock.
 *  Returns false when the lock is lost (a successor owns it or it was fully
 *  reclaimed) → caller must exit. A reviving zombie re-enters only when NO
 *  fresh holder exists, and then still only writes its own entry. */
export function heartbeatLock(token, staleMs = LOCK_STALE_MS) {
  try {
    const mine = join(token.path, entryName(token.secret))
    const w = winner(token.path, staleMs)
    if (w && w.token !== token.secret) return false // another live holder — exit, don't resurrect my file
    writeFileSync(mine, JSON.stringify({ pid: token.pid, token: token.secret, at: new Date().toISOString() }))
    return winner(token.path, staleMs)?.token === token.secret
  } catch { return false }
}

/** Release ONLY my own entry — successor files are unreachable by design. */
export function releaseLock(token) {
  try { unlinkSync(join(token.path, entryName(token.secret))) } catch { /* best-effort */ }
}

/** Is a fresh (non-stale) lock currently held? */
export function lockHeld(path, staleMs = LOCK_STALE_MS) {
  return winner(path, staleMs) != null
}

/** Live lock payload for diagnostics / stop-token relay: {pid,token,at} or null. */
export function readLock(path, staleMs = LOCK_STALE_MS) {
  const w = winner(path, staleMs)
  return w ? { pid: w.pid, token: w.token, at: w.at } : null
}
