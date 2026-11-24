// Model catalog loader: cache + single-flight around one `omp models ls`.
//
// A failed or timed-out listing MUST reject. Returning [] would look like a
// successful empty catalog, stop the panel's retry loop, and blank the model
// pickers. The caller (worker) turns a rejection into a failed fusion.status.

export const MODELS_TIMEOUT_MS = 20_000
export const MODEL_CATALOG_TTL_MS = 60_000

// Parse one `omp models ls` payload. `[]` is a real empty catalog; a non-empty
// array whose records all lack a usable selector/id is a malformed response.
// Collapsing that to [] would overwrite a good disk snapshot and stop retries.
export function parseModelRows(rows) {
  if (!Array.isArray(rows)) throw new Error('OMP models ls 返回了无效的模型列表。')
  const models = rows.flatMap((row) => {
    const selector = typeof row?.selector === 'string' ? row.selector.trim() : ''
    const fallbackId = typeof row?.id === 'string' ? row.id.trim() : ''
    const id = selector || fallbackId
    if (!id) return []
    return [{
      id,
      name: typeof row.name === 'string' && row.name.trim() ? row.name : id,
      provider: row.provider,
      thinking: Array.isArray(row.thinking) ? row.thinking.filter((level) => typeof level === 'string') : [],
    }]
  })
  if (rows.length > 0 && models.length === 0) {
    throw new Error(`OMP models ls 返回了 ${rows.length} 条记录，但没有可用的 selector/id。`)
  }
  return models
}

// The devin provider ships ~1000 `fusion-<driver>-<effort>-sidekick-<sidekick>`
// combos next to ~76 plain models. They are one-off compositions of the same
// models, swamp every search ("swe2" hits ~285 of them), and push the real
// entry past the picker's row cap. Hide exactly those selectors — a model named
// `my-fusion-model`, or another provider's `fusion-alpha`, stays visible.
const FUSION_SELECTOR_PREFIX = 'devin/fusion-'

export function isFusionModel(model) {
  const id = typeof model?.id === 'string' ? model.id.trim().toLowerCase() : ''
  return id.startsWith(FUSION_SELECTOR_PREFIX)
}

// "swe2" must find `devin/swe-2`: compare with separators stripped, and rank
// id hits above name hits so the canonical model is not cut by the row cap.
// Unicode letters/digits are kept, so a Chinese model name still matches. A
// query with no letters/digits at all behaves like an empty query, exactly as
// the separator-insensitive search did before this picker work.
const squash = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

function rank(model, needle) {
  const id = squash(model.id)
  const name = squash(model.name)
  // The selector tail is the model itself (`devin/swe-2`), so it outranks a
  // provider-wide id or name hit.
  const tail = squash(String(model.id ?? '').slice(String(model.id ?? '').lastIndexOf('/') + 1))
  if (id === needle || tail === needle) return 0
  if (tail.startsWith(needle)) return 1
  if (name === needle) return 2
  if (name.startsWith(needle)) return 3
  if (id.startsWith(needle)) return 4
  if (id.includes(needle)) return 5
  if (name.includes(needle)) return 6
  return -1
}

export function filterModelChoices(models, query, { limit = 200 } = {}) {
  const needle = squash(query)
  const scored = []
  for (const model of models) {
    if (isFusionModel(model)) continue
    const score = needle ? rank(model, needle) : 0
    if (score < 0) continue
    scored.push({ model, score })
  }
  // Stable: catalog order is the tiebreaker, so equal ranks keep OMP's order.
  if (needle) scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, limit).map((entry) => entry.model)
}

export function createModelCatalog({ run, now = Date.now, ttl = MODEL_CATALOG_TTL_MS } = {}) {
  let cached = null
  let pending = null
  return function loadModels(force = false) {
    if (!force && cached && now() - cached.at < ttl) return Promise.resolve(cached.models)
    // Panel requests time out before a slow CLI necessarily exits; share the
    // in-flight run so retries cannot fork more `omp models ls` processes.
    if (pending) return pending
    pending = (async () => {
      try {
        const models = await run()
        if (!Array.isArray(models)) throw new Error('OMP models ls 返回了无效的模型列表。')
        cached = { at: now(), models }
        return models
      } finally {
        pending = null
      }
    })()
    return pending
  }
}
