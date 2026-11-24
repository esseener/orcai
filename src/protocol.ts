export type RoutingRules = {
  useBuiltin: boolean
  replanPhrases: string[]
  executePhrases: string[]
  planRequired: string[]
}

export type FusionState = {
  enabled: boolean
  from: string | null
  fromEffort: string | null
  into: string | null
  intoEffort: string | null
  taskPrewalk: boolean
  advisor: boolean
  advisorModel: string | null
  advisorEffort: string | null
  ocr: boolean
  ocrModel: string | null
  ocrEffort: string | null
  rulePath: string | null
  checkCmd: string | null
  autoReview: boolean
  autoRework: boolean
  maxRework: number
  routing: RoutingRules
}

export type FusionPatch = Partial<Omit<FusionState, 'routing'>> & { routing?: RoutingRules }
export type OmpModel = { id: string; name: string; provider?: string; thinking: string[] }
export type ModelSwitch = { at: string; model: string; thinking: string | null }
export type SessionStage = 'planning' | 'executing' | 'reviewing' | 'reworking' | 'idle' | 'unknown'
export type SessionStatus = {
  file: string | null; ageMs: number | null
  currentModel: string | null; currentThinking: string | null
  switches: ModelSwitch[]
  lastTool: string | null; lastToolAt: string | null
  stage: SessionStage
  stageModel: string | null
}

export type AcceptanceCfg = {
  ocr: boolean; ocrModel: string | null; ocrEffort: string | null; rulePath: string | null
  checkCmd: string | null; autoReview: boolean; autoRework: boolean; maxRework: number
  autoRoute: boolean; planner: string | null; executor: string | null
  routing: RoutingRules
}
export type ReviewVerdict = 'pass' | 'rework' | 'unreviewed' | 'failed' | 'no-repo' | 'none'
export type Finding = { severity: string; file: string; line: number | null; message: string }
export type ReviewOut = { verdict: ReviewVerdict; findings: Finding[]; summary: string; at: string | null; round: number | null; consumed: boolean; driverAlive: boolean; driverPid: number | null }

declare module 'orca' {
  interface PluginRequests {
    'fusion.status': { input: {}; output: { models: OmpModel[]; fusion: FusionState } }
    'models.list': { input: { force?: boolean }; output: OmpModel[] }
    'fusion.set': { input: FusionPatch; output: FusionState }
    'acceptance.review': { input: { repo?: string; commit?: string; from?: string; to?: string }; output: { verdict: ReviewVerdict; findings: Finding[]; summary: string; sarif?: string } }
    'acceptance.result': { input: { repo?: string }; output: ReviewOut }
    'acceptance.stop': { input: { repo?: string; force?: boolean }; output: { stopped: boolean; note: string } }
    'session.status': { input: { file?: string }; output: SessionStatus }
    'session.list': { input: {}; output: { sessions: { file: string; dir: string; ageMs: number; active: boolean; recent: boolean; sessionId: string | null; hostState: 'working' | 'blocked' | 'waiting' | 'done' | null; title: string | null; cwd: string | null; model: string | null; thinking: string | null; stage: SessionStage; lastTool: string | null; lastToolAt: string | null }[]; activeError: string | null } }
  }
}
