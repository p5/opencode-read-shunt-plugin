import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { HostAdapter, SummaryRequest, SummaryWorker } from "../contracts.js"
import { isRecord, resolvePolicyConfig, selectCandidate, type ShuntPolicyConfig } from "../core.js"
import { ReadShuntService } from "../service.js"
import { FileSavingsStore } from "./file-savings-store.js"

export type CodexHookInput = {
  session_id?: unknown
  transcript_path?: unknown
  cwd?: unknown
  hook_event_name?: unknown
  tool_name?: unknown
  tool_input?: unknown
  tool_response?: unknown
}

export type CodexHookOutput = {
  decision: "block"
  reason: string
}

export type CodexConfig = ShuntPolicyConfig & {
  codexCommand: string
  codexModel: string
  reasoningEffort: CodexReasoningEffort
  stateDirectory: string
  statsFile: string
}

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh"

const codexReasoningEfforts: readonly CodexReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]

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

export class CodexAdapter implements HostAdapter<CodexHookInput, CodexHookOutput | undefined> {
  readonly host = "codex" as const
  private readonly service: ReadShuntService

  constructor(
    private readonly config: CodexConfig,
    worker: SummaryWorker = new CodexCliSummaryWorker(config),
  ) {
    this.service = new ReadShuntService(
      worker,
      new FileSavingsStore(config.stateDirectory, config.statsFile),
    )
  }

  async handle(input: CodexHookInput): Promise<CodexHookOutput | undefined> {
    const candidate = codexCandidate(input, this.config)
    if (!candidate) return

    const task = await readCurrentTask(input.transcript_path)
    const result = await this.service.shunt({
      host: this.host,
      sessionID: stringOr(input.session_id, "unknown"),
      task: task ?? "Understand the relevant code and preserve exact identifiers.",
      candidate,
      config: this.config,
    })
    if (!result) return

    console.error(
      `read-shunt saved about ${result.entry.estimatedSavedTokens} main-context tokens; ` +
        `session total about ${result.entry.sessionEstimatedSavedTokens}`,
    )
    return { decision: "block", reason: result.replacement.text }
  }
}

export async function loadCodexConfig(
  cwd: string,
  environment = process.env,
): Promise<CodexConfig> {
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
  const codexModel = environment.READ_SHUNT_CODEX_MODEL ?? stringOr(fileConfig.model, "gpt-5.6-luna")
  const base = resolvePolicyConfig({
    thresholdChars: integer(environment.READ_SHUNT_THRESHOLD_CHARS) ?? fileConfig.thresholdChars,
    thresholdLines: integer(environment.READ_SHUNT_THRESHOLD_LINES) ?? fileConfig.thresholdLines,
    maxSummaryChars: integer(environment.READ_SHUNT_MAX_SUMMARY_CHARS) ?? fileConfig.maxSummaryChars,
    generationTimeoutMs: integer(environment.READ_SHUNT_TIMEOUT_MS) ?? fileConfig.generationTimeoutMs,
  })
  return {
    ...base,
    codexCommand: environment.READ_SHUNT_CODEX_COMMAND ?? stringOr(fileConfig.codexCommand, "codex"),
    codexModel,
    reasoningEffort: reasoningEffort(
      environment.READ_SHUNT_CODEX_REASONING_EFFORT ?? fileConfig.reasoningEffort,
    ),
    stateDirectory,
    statsFile:
      environment.READ_SHUNT_STATS_FILE ?? stringOr(fileConfig.statsFile, join(stateDirectory, "read-shunt.jsonl")),
  }
}

async function readConfig(path: string): Promise<CodexFileConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

export function codexCandidate(input: CodexHookInput, config: ShuntPolicyConfig) {
  if (input.hook_event_name !== "PostToolUse" || input.tool_name !== "Bash") return
  if (!isRecord(input.tool_input) || typeof input.tool_input.command !== "string") return
  if (!isBroadReadCommand(input.tool_input.command)) return
  const content = textResponse(input.tool_response)
  if (!content) return

  return selectCandidate(
    {
      path: readTarget(input.tool_input.command),
      content,
    },
    config,
  )
}

export function isBroadReadCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || /[|>&;\n]/.test(trimmed)) return false
  return /^(?:command\s+)?(?:cat|less|more)(?:\s|$)/.test(trimmed)
}

export function parseCodexOutput(output: string): string | undefined {
  let message: string | undefined
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as unknown
      if (!isRecord(event) || event.type !== "item.completed" || !isRecord(event.item)) continue
      if (event.item.type === "agent_message" && typeof event.item.text === "string") message = event.item.text
    } catch {}
  }
  return message
}

class CodexCliSummaryWorker implements SummaryWorker {
  readonly model: string

  constructor(private readonly config: CodexConfig) {
    this.model = `openai/${config.codexModel}`
  }

  async summarize(request: SummaryRequest): Promise<string> {
    const child = Bun.spawn(buildCodexArguments(this.config), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(buildCodexPrompt(request))
    child.stdin.end()

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const expired = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          child.kill()
          reject(new Error(`generation timed out after ${request.timeoutMs} ms`))
        }, request.timeoutMs)
      })
      const output = await Promise.race([new Response(child.stdout).text(), expired])
      const exitCode = await child.exited
      if (exitCode !== 0) {
        const error = (await new Response(child.stderr).text()).trim()
        throw new Error(error || `codex worker exited with ${exitCode}`)
      }
      const message = parseCodexOutput(output)
      if (!message) throw new Error("codex worker returned no agent message")
      return message
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}

export function buildCodexArguments(config: CodexConfig): string[] {
  return [
    config.codexCommand,
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    config.codexModel,
    "--config",
    `model_reasoning_effort="${config.reasoningEffort}"`,
    "--json",
    "-",
  ]
}

function buildCodexPrompt(request: SummaryRequest): string {
  return [
    "Summarize the supplied command output for another coding agent.",
    "Do not call tools. Use only the supplied text.",
    `Current task: ${request.task}`,
    `Return plain text with at most ${request.maxSummaryChars} characters.`,
    "Use short bullets. Preserve exact names, types, paths, errors, and line numbers.",
    "Include only facts that help with the current task.",
    `Command: ${request.candidate.path}`,
    "",
    request.candidate.content,
  ].join("\n")
}

async function readCurrentTask(path: unknown): Promise<string | undefined> {
  if (typeof path !== "string") return
  try {
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n")
    for (let index = lines.length - 1; index >= 0; index--) {
      const task = userText(JSON.parse(lines[index]!) as unknown)
      if (task) return task.slice(0, 2_000)
    }
  } catch {}
}

function userText(value: unknown): string | undefined {
  if (!isRecord(value)) return
  if (value.role === "user") {
    if (typeof value.content === "string") return value.content
    if (Array.isArray(value.content)) {
      const text = value.content
        .filter(isRecord)
        .filter((part) => part.type === "input_text" || part.type === "text")
        .map((part) => part.text)
        .filter((part): part is string => typeof part === "string")
        .join("\n")
      if (text) return text
    }
  }
  for (const child of Object.values(value)) {
    const text = userText(child)
    if (text) return text
    if (Array.isArray(child)) {
      for (const item of child) {
        const nested = userText(item)
        if (nested) return nested
      }
    }
  }
}

function textResponse(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!isRecord(value)) return
  for (const key of ["output", "content", "text"] as const) {
    const content = value[key]
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      const text = content
        .filter(isRecord)
        .map((part) => part.text)
        .filter((part): part is string => typeof part === "string")
        .join("\n")
      if (text) return text
    }
  }
}

function readTarget(command: string): string {
  const argumentsOnly = command.trim().replace(/^(?:command\s+)?(?:cat|less|more)\s*/, "")
  const target = argumentsOnly
    .split(/\s+/)
    .filter((argument) => !argument.startsWith("-"))
    .at(-1)
  return (target ?? command).replaceAll(/["']/g, "").slice(0, 500)
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

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function reasoningEffort(value: unknown): CodexReasoningEffort {
  return codexReasoningEfforts.includes(value as CodexReasoningEffort)
    ? (value as CodexReasoningEffort)
    : "low"
}
