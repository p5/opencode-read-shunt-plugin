import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ThinkingLevel } from "@earendil-works/pi-ai"
import { isRecord, resolvePolicyConfig, type ShuntPolicyConfig } from "../core.js"

export type PiConfig = ShuntPolicyConfig & {
  model: {
    provider: string
    id: string
  }
  reasoningEffort: ThinkingLevel
  stateDirectory: string
  statsFile: string
}

export type PiFileConfig = {
  thresholdChars?: unknown
  thresholdLines?: unknown
  maxSummaryChars?: unknown
  generationTimeoutMs?: unknown
  model?: unknown
  reasoningEffort?: unknown
  statsFile?: unknown
}

const reasoningEfforts: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"]

export async function loadPiConfig(cwd: string, environment = process.env): Promise<PiConfig> {
  const agentDirectory = environment.PI_CODING_AGENT_DIR ?? join(environment.HOME ?? ".", ".pi", "agent")
  const fileConfig = {
    ...(await readConfig(join(agentDirectory, "read-shunt.json"))),
    ...(await readConfig(join(cwd, ".pi", "read-shunt.json"))),
  }
  return resolvePiConfig(environment, fileConfig)
}

export function resolvePiConfig(
  environment = process.env,
  fileConfig: PiFileConfig = {},
): PiConfig {
  const stateRoot = environment.XDG_STATE_HOME ?? join(environment.HOME ?? ".", ".local", "state")
  const stateDirectory = join(stateRoot, "pi", "read-shunt")
  const model = isRecord(fileConfig.model) ? fileConfig.model : {}
  return {
    ...resolvePolicyConfig({
      thresholdChars: integer(environment.READ_SHUNT_THRESHOLD_CHARS) ?? fileConfig.thresholdChars,
      thresholdLines: integer(environment.READ_SHUNT_THRESHOLD_LINES) ?? fileConfig.thresholdLines,
      maxSummaryChars: integer(environment.READ_SHUNT_MAX_SUMMARY_CHARS) ?? fileConfig.maxSummaryChars,
      generationTimeoutMs: integer(environment.READ_SHUNT_TIMEOUT_MS) ?? fileConfig.generationTimeoutMs,
    }),
    model: {
      provider: environment.READ_SHUNT_PI_PROVIDER ?? stringOr(model.provider, "google-vertex"),
      id: environment.READ_SHUNT_PI_MODEL ?? stringOr(model.id, "gemini-2.5-flash"),
    },
    reasoningEffort: reasoningEffort(
      environment.READ_SHUNT_PI_REASONING_EFFORT ?? fileConfig.reasoningEffort,
    ),
    stateDirectory,
    statsFile:
      environment.READ_SHUNT_STATS_FILE ?? stringOr(fileConfig.statsFile, join(stateDirectory, "read-shunt.jsonl")),
  }
}

async function readConfig(path: string): Promise<PiFileConfig> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function integer(value: string | undefined): number | undefined {
  if (value === undefined) return
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function reasoningEffort(value: unknown): ThinkingLevel {
  return isReasoningEffort(value) ? value : "low"
}

function isReasoningEffort(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (reasoningEfforts as readonly string[]).includes(value)
}
