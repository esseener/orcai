export const RECENT_WINDOW_MINUTES = 20
export const RECENT_WINDOW_MS = RECENT_WINDOW_MINUTES * 60_000

/** Session ids are the UUID suffix of the OMP JSONL filename. */
export function sessionIdFromFile(file) {
  const base = String(file).replace(/\\/g, '/').split('/').pop() ?? ''
  const withoutExt = base.replace(/\.jsonl$/i, '')
  const cut = withoutExt.lastIndexOf('_')
  return cut >= 0 ? withoutExt.slice(cut + 1) : null
}

export function isRecent(mtime, now = Date.now(), windowMs = RECENT_WINDOW_MS) {
  return now - mtime <= windowMs
}

export function hostActive(state) {
  return state === 'working'
}

/** Keep recent records, plus any session Orca still runs (even past the window). */
export function sessionVisible(row) {
  return row.recent === true || (row.hostState != null && row.hostState !== 'done')
}

/** Active sessions first; each group newest first, with a stable file tie-break. */
export function sortSessions(rows) {
  return [...rows].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    const aa = Number.isFinite(a.ageMs) ? a.ageMs : Number.POSITIVE_INFINITY
    const bb = Number.isFinite(b.ageMs) ? b.ageMs : Number.POSITIVE_INFINITY
    return aa - bb || String(a.file).localeCompare(String(b.file))
  })
}

/** Apply an Orca status event only to the row with the same agent session id. */
export function applyHostState(row, sessionId, state) {
  if (!sessionId || row.sessionId !== sessionId) return row
  return { ...row, hostState: state, active: hostActive(state) }
}
