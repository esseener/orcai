export type RoutingRules = {
  useBuiltin: boolean
  replanPhrases: string[]
  executePhrases: string[]
  planRequired: string[]
}

export const ROUTING_LIMITS: { phrases: number; planRequired: number; phraseLength: number }
export const DEFAULT_ROUTING: Readonly<RoutingRules>
export function normalizeRoutingRules(value: unknown): RoutingRules
export function wantsExecution(text: string, rules?: RoutingRules): boolean
export function missingPlanRequirements(content: string, rules?: RoutingRules): string[]
