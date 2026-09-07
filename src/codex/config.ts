import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isRecord, resolvePolicyConfig, type ShuntPolicyConfig } from "../core.js"

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh"

export type CodexConfig = ShuntPolicyConfig & {
  codexCommand: string
  codexModel: string
  reasoningEffort: CodexReasoningEffort
  stateDirectory: string
  statsFile: string
}

export type CodexFileConfig = {
  thresholdChars?: unknown
  thresholdLines?: unknown
  maxSummaryChars?: unknown
  generationTimeoutMs?: unknown
  model?: unknown
  reasoningEffort?: unknown
  codexCommand?: unknown
  statsFile?: unknown
}

const hookTimeoutLimitMs = 40_000
const reasoningEfforts: readonly CodexReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"]

export async function loadCodexConfig(cwd: string, environment = process.env): Promise<CodexConfig> {
  const stateDirectory = environment.PLUGIN_DATA ?? codexStateDirectory(environment)
  const fileConfig = {
    ...(await readConfig(join(stateDirectory, "config.json"))),
    ...(await readConfig(join(cwd, ".codex", "read-shunt.json"))),
  }
  return resolveCodexConfig(environment, fileConfig)
}

export function resolveCodexConfig(
  environment = process.env,
  fileConfig: CodexFileConfig = {},
): CodexConfig {
  const stateDirectory = environment.PLUGIN_DATA ?? codexStateDirectory(environment)
  const policy = resolvePolicyConfig({
      thresholdChars: integer(environment.READ_SHUNT_THRESHOLD_CHARS) ?? fileConfig.thresholdChars,
      thresholdLines: integer(environment.READ_SHUNT_THRESHOLD_LINES) ?? fileConfig.thresholdLines,
      maxSummaryChars: integer(environment.READ_SHUNT_MAX_SUMMARY_CHARS) ?? fileConfig.maxSummaryChars,
      generationTimeoutMs: integer(environment.READ_SHUNT_TIMEOUT_MS) ?? fileConfig.generationTimeoutMs,
    })
  return {
    ...policy,
    generationTimeoutMs: Math.min(policy.generationTimeoutMs, hookTimeoutLimitMs),
    codexCommand: environment.READ_SHUNT_CODEX_COMMAND ?? textOr(fileConfig.codexCommand, "codex"),
    codexModel: environment.READ_SHUNT_CODEX_MODEL ?? textOr(fileConfig.model, "gpt-5.6-luna"),
    reasoningEffort: reasoningEffort(
      environment.READ_SHUNT_CODEX_REASONING_EFFORT ?? fileConfig.reasoningEffort,
    ),
    stateDirectory,
    statsFile:
      environment.READ_SHUNT_STATS_FILE ?? textOr(fileConfig.statsFile, join(stateDirectory, "read-shunt.jsonl")),
  }
}

async function readConfig(path: string): Promise<CodexFileConfig> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

function codexStateDirectory(environment: NodeJS.ProcessEnv): string {
  const stateRoot = environment.XDG_STATE_HOME ?? `${environment.HOME ?? "."}/.local/state`
  return join(stateRoot, "codex", "read-shunt")
}

function integer(value: string | undefined): number | undefined {
  if (value === undefined) return
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function reasoningEffort(value: unknown): CodexReasoningEffort {
  return isReasoningEffort(value) ? value : "low"
}

function isReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === "string" && (reasoningEfforts as readonly string[]).includes(value)
}
