import type { OmpModel } from './protocol'

export const MODELS_TIMEOUT_MS: number
export const MODEL_CATALOG_TTL_MS: number

export function parseModelRows(rows: unknown): OmpModel[]

export function isFusionModel(model: Pick<OmpModel, 'id'>): boolean

export function filterModelChoices(
  models: OmpModel[],
  query: string,
  options?: { limit?: number },
): OmpModel[]

export function createModelCatalog(options: {
  run: () => Promise<OmpModel[]>
  now?: () => number
  ttl?: number
}): (force?: boolean) => Promise<OmpModel[]>
