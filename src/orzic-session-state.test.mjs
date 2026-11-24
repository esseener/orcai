import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECENT_WINDOW_MS, applyHostState, hostActive, isRecent, sessionIdFromFile, sessionVisible, sortSessions,
} from './orzic-session-state.mjs'

test('session ids come from the JSONL suffix, not titles or cwd', () => {
  assert.equal(
    sessionIdFromFile('C:\\sessions\\2026-11-24T05-00-00-000Z_01a20bee-38a9-77a7-b3d7-a6b0f46068d8.jsonl'),
    '01a20bee-38a9-77a7-b3d7-a6b0f46068d8',
  )
  assert.equal(sessionIdFromFile('/tmp/alpha.jsonl'), null)
  // Two sessions in the same project keep distinct ids.
  const a = sessionIdFromFile('C:\\sessions\\2026-11-24T05-00-00-000Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl')
  const b = sessionIdFromFile('C:\\sessions\\2026-11-24T05-00-00-000Z_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl')
  assert.notEqual(a, b)
})

test('the recent window is exactly twenty minutes', () => {
  const now = 1_800_000_000_000
  assert.equal(RECENT_WINDOW_MS, 20 * 60_000)
  assert.equal(isRecent(now - RECENT_WINDOW_MS, now), true)
  assert.equal(isRecent(now - RECENT_WINDOW_MS - 1, now), false)
})

test('a working session stays visible past the window, a done one does not', () => {
  assert.equal(sessionVisible({ recent: false, hostState: 'working' }), true)
  assert.equal(sessionVisible({ recent: false, hostState: 'blocked' }), true)
  assert.equal(sessionVisible({ recent: false, hostState: 'done' }), false)
  assert.equal(sessionVisible({ recent: false, hostState: null }), false)
  assert.equal(sessionVisible({ recent: true, hostState: null }), true)
})

test('active sessions sort first, then each group by newest activity', () => {
  const rows = [
    { file: 'inactive-new', active: false, ageMs: 1_000 },
    { file: 'active-old', active: true, ageMs: 60_000 },
    { file: 'inactive-old', active: false, ageMs: 90_000 },
    { file: 'active-new', active: true, ageMs: 2_000 },
  ]
  assert.deepEqual(sortSessions(rows).map((row) => row.file), ['active-new', 'active-old', 'inactive-new', 'inactive-old'])
  // Equal age keeps a deterministic file order.
  assert.deepEqual(
    sortSessions([{ file: 'b', active: true, ageMs: 1 }, { file: 'a', active: true, ageMs: 1 }]).map((row) => row.file),
    ['a', 'b'],
  )
})

test('a status event only changes the matching session id', () => {
  const alpha = { sessionId: 'alpha', hostState: null, active: false, cwd: 'C:\\same', title: 'same' }
  const beta = { sessionId: 'beta', hostState: null, active: false, cwd: 'C:\\same', title: 'same' }
  const after = applyHostState(alpha, 'beta', 'working')
  assert.equal(after, alpha)
  assert.equal(beta.active, false)
  assert.deepEqual(applyHostState(alpha, 'alpha', 'working'), { ...alpha, hostState: 'working', active: true })
  assert.equal(hostActive('working'), true)
  assert.equal(hostActive('done'), false)
  assert.equal(hostActive(null), false)
})
