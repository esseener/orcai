export const ROUTING_LIMITS = { phrases: 20, planRequired: 10, phraseLength: 80 }

export const DEFAULT_ROUTING = Object.freeze({
  useBuiltin: true,
  replanPhrases: [],
  executePhrases: [],
  planRequired: [],
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

export function normalizeRoutingRules(value) {
  const row = value && typeof value === 'object' ? value : {}
  return {
    useBuiltin: row.useBuiltin !== false,
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
