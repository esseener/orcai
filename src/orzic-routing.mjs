export const ROUTING_LIMITS = { phrases: 20, planRequired: 10, phraseLength: 80 }

// Visible starter rules. They are ordinary editable phrases; nothing hidden.
// Re-plan phrases are checked first, so a negative phrase such as
// "不要直接执行" pulls a session back instead of matching "直接执行".
export const DEFAULT_ROUTING = Object.freeze({
  useBuiltin: true,
  presetVersion: 1,
  replanPhrases: Object.freeze([
    '重新规划', '重新计划', '重新评估',
    '审查一下', '评估一下', '分析一下', '复盘一下', '拆解一下',
    '先做计划', '先写计划', '先给方案', '换个方案', '换一个方案', '换个思路',
    '不要直接执行', '不要开始执行', '不要开始实现', '不要继续执行', '不要执行', '先别执行',
  ]),
  executePhrases: Object.freeze([
    '开始实现', '开始执行', '继续实现', '继续执行',
    '按计划执行', '按计划实现', '执行计划', '接着做', '动手吧', '开干', '开工',
    '开始做', '继续推进', '直接实现', '直接执行',
    'start implementing', 'implement it', 'go ahead', 'proceed', 'continue',
  ]),
  planRequired: Object.freeze([]),
})

const cleanPhrases = (value, limit) => {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const raw of value) {
    const phrase = String(raw ?? '').trim().slice(0, ROUTING_LIMITS.phraseLength)
    const key = phrase.toLowerCase()
    if (!phrase || seen.has(key)) continue
    seen.add(key)
    out.push(phrase)
    if (out.length >= limit) break
  }
  return out
}

const cloneDefault = () => ({
  useBuiltin: DEFAULT_ROUTING.useBuiltin,
  presetVersion: DEFAULT_ROUTING.presetVersion,
  replanPhrases: [...DEFAULT_ROUTING.replanPhrases],
  executePhrases: [...DEFAULT_ROUTING.executePhrases],
  planRequired: [...DEFAULT_ROUTING.planRequired],
})

export function normalizeRoutingRules(value) {
  const row = value && typeof value === 'object' ? value : null
  const hasSavedMarker = typeof row?.presetVersion === 'number' && row.presetVersion >= 1
  const hasCustomLists = Boolean(row && (
    (Array.isArray(row.replanPhrases) && row.replanPhrases.length) ||
    (Array.isArray(row.executePhrases) && row.executePhrases.length) ||
    (Array.isArray(row.planRequired) && row.planRequired.length)
  ))
  // A pre-preset config with the built-in matcher on and no custom lists is
  // the old empty default: show the starter rules. An explicit empty save has
  // presetVersion and stays empty.
  if (!row || (!hasSavedMarker && !hasCustomLists && row.useBuiltin !== false)) return cloneDefault()
  return {
    useBuiltin: row.useBuiltin !== false,
    presetVersion: 1,
    replanPhrases: cleanPhrases(row.replanPhrases, ROUTING_LIMITS.phrases),
    executePhrases: cleanPhrases(row.executePhrases, ROUTING_LIMITS.phrases),
    planRequired: cleanPhrases(row.planRequired, ROUTING_LIMITS.planRequired),
  }
}

// Literal, case-insensitive matching. A re-plan phrase wins when a message
// contains both kinds, so a custom rule can always pull a session back.
const ACK_ONLY = /^(?:继续(?:执行|实现)?|按计划(?:执行|实现)?|开始(?:执行|实现)?|执行计划|好(?:的)?|可以|行|ok|continue|proceed)[。！!.\s]*$/i
const EXECUTION_INTENT = /(继续(?:执行|实现|做|干|推进)?|开始(?:执行|实现|实施|做|干)?|执行(?:下去|计划|吧|起来)?|按计划|动手|开干|开工|实施|落地|授权|直接做|直接执行|go\s*ahead|proceed|continue|do\s*it)/i
const REPLAN_INTENT = /(重新(?:规划|计划|审查|评估|分析|设计)|(?:做|写|出|列|改|调整|更新)(?:个|一个|一下)?(?:计划|方案)|规划一下|计划一下|审查|评估|分析|复盘|拆解一下)/i

const hasPhrase = (text, phrases) => phrases.some((phrase) => text.includes(phrase.toLowerCase()))

export function wantsExecution(text, rules = DEFAULT_ROUTING) {
  const value = String(text ?? '')
  const normalized = normalizeRoutingRules(rules)
  const lower = value.toLowerCase()
  if (hasPhrase(lower, normalized.replanPhrases)) return false
  if (hasPhrase(lower, normalized.executePhrases)) return true
  if (!normalized.useBuiltin) return false
  return ACK_ONLY.test(value) || (EXECUTION_INTENT.test(value) && !REPLAN_INTENT.test(value))
}

export function missingPlanRequirements(content, rules = DEFAULT_ROUTING) {
  const text = String(content ?? '').toLowerCase()
  return normalizeRoutingRules(rules).planRequired.filter((phrase) => !text.includes(phrase.toLowerCase()))
}
