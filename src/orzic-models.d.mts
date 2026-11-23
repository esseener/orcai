import type { OmpModel } from './protocol'

export const MODELS_TIMEOUT_MS: number
export const MODEL_CATALOG_TTL_MS: number

export function createModelCatalog(options: {
  run: () => Promise<OmpModel[]>
  now?: () => number
  ttl?: number
}): () => Promise<OmpModel[]>
