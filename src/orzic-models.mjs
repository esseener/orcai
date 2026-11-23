// Model catalog loader: cache + single-flight around one `omp models ls`.
//
// A failed or timed-out listing MUST reject. Returning [] would look like a
// successful empty catalog, stop the panel's retry loop, and blank the model
// pickers. The caller (worker) turns a rejection into a failed fusion.status.

export const MODELS_TIMEOUT_MS = 20_000
export const MODEL_CATALOG_TTL_MS = 60_000

export function createModelCatalog({ run, now = Date.now, ttl = MODEL_CATALOG_TTL_MS } = {}) {
  let cached = null
  let pending = null
  return function loadModels() {
    if (cached && now() - cached.at < ttl) return Promise.resolve(cached.models)
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
