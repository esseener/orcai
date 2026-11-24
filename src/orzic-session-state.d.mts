export type HostAgentState = 'working' | 'blocked' | 'waiting' | 'done'

export const RECENT_WINDOW_MINUTES: number
export const RECENT_WINDOW_MS: number
export function sessionIdFromFile(file: string): string | null
export function isRecent(mtime: number, now?: number, windowMs?: number): boolean
export function hostActive(state: HostAgentState | null | undefined): boolean
export function sessionVisible(row: { recent: boolean; hostState: HostAgentState | null }): boolean
export function sortSessions<T extends { active: boolean; ageMs: number; file: string }>(rows: readonly T[]): T[]
export function applyHostState<T extends { sessionId: string | null; hostState: HostAgentState | null; active: boolean }>(
  row: T,
  sessionId: string | null,
  state: HostAgentState,
): T
export function mergeHostOverrides<T extends { sessionId: string | null; hostState: HostAgentState | null; active: boolean }>(
  rows: readonly T[],
  overrides: Map<string, HostAgentState>,
): T[]
