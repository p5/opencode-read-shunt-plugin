import { isRecord, resolvePolicyConfig, type ShuntPolicyConfig } from "../core.js"

export type ModelRef = {
  providerID: string
  id: string
}

export type OpenCodeConfig = ShuntPolicyConfig & {
  allowedAgents: readonly string[]
  model: ModelRef
  statsFile: string
}

const defaults = {
  allowedAgents: ["explore"],
  model: {
    providerID: "google-vertex",
    id: "gemini-2.5-flash",
  },
} as const

export function resolveOpenCodeConfig(
  options: Readonly<Record<string, unknown>>,
  environment = process.env,
): OpenCodeConfig {
  const stateRoot = environment.XDG_STATE_HOME ?? `${environment.HOME ?? "."}/.local/state`
  const model = isRecord(options.model) ? options.model : {}
  return {
    ...resolvePolicyConfig(options),
    allowedAgents: stringArray(options.allowedAgents, defaults.allowedAgents),
    model: {
      providerID: stringValue(model.providerID, defaults.model.providerID),
      id: stringValue(model.id, defaults.model.id),
    },
    statsFile: stringValue(options.statsFile, `${stateRoot}/opencode/read-shunt.jsonl`),
  }
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) return fallback
  return value
}

