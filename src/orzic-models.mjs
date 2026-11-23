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
