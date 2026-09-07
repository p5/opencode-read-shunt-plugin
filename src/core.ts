export type ModelRef = {
  providerID: string
  id: string
}

export type ReadShuntConfig = {
  thresholdChars: number
  thresholdLines: number
  maxSummaryChars: number
  generationTimeoutMs: number
  allowedAgents: readonly string[]
  model: ModelRef
  statsFile: string
}

export type ToolResult = {
  output?: unknown
  content?: unknown
  metadata?: Readonly<Record<string, unknown>>
}

export type CompletedToolEvent = {
  tool: string
  sessionID: string
  agent: string
  status: "completed"
  input: unknown
  result: ToolResult
}

export type ReadCandidate = {
  path: string
  content: string
  usesContentParts: boolean
  truncated: boolean
  lines: number
}

export type SessionSavings = {
  shunts: number
  savedChars: number
}

export type Replacement = {
  text: string
  summaryChars: number
  replacementChars: number
  savedChars: number
  estimatedSavedTokens: number
  session: SessionSavings
}

const defaults = {
  thresholdChars: 12_000,
  thresholdLines: 350,
  maxSummaryChars: 4_000,
  generationTimeoutMs: 30_000,
  allowedAgents: ["explore"],
  model: {
    providerID: "google-vertex",
    id: "gemini-2.5-flash",
  },
} as const

export function resolveConfig(options: Readonly<Record<string, unknown>>, environment = process.env): ReadShuntConfig {
  const stateRoot = environment.XDG_STATE_HOME ?? `${environment.HOME ?? "."}/.local/state`
  const model = isRecord(options.model) ? options.model : {}
  return {
    thresholdChars: positiveInteger(options.thresholdChars, defaults.thresholdChars),
    thresholdLines: positiveInteger(options.thresholdLines, defaults.thresholdLines),
    maxSummaryChars: positiveInteger(options.maxSummaryChars, defaults.maxSummaryChars),
    generationTimeoutMs: positiveInteger(options.generationTimeoutMs, defaults.generationTimeoutMs),
    allowedAgents: stringArray(options.allowedAgents, defaults.allowedAgents),
    model: {
      providerID: stringValue(model.providerID, defaults.model.providerID),
      id: stringValue(model.id, defaults.model.id),
    },
    statsFile: stringValue(options.statsFile, `${stateRoot}/opencode/read-shunt.jsonl`),
  }
}

export function readCandidate(event: CompletedToolEvent, config: ReadShuntConfig): ReadCandidate | undefined {
  if (event.tool !== "read" || !config.allowedAgents.includes(event.agent)) return
  if (!isRecord(event.input) || typeof event.input.path !== "string" || event.input.path.length === 0) return
  if (event.input.offset !== undefined || event.input.limit !== undefined) return
  if (isInstructionFile(event.input.path)) return
  const content = parseTextContent(event.result.content)
  if (!content || !isRecord(event.result.output)) return
  if (event.result.output.encoding === "base64") return
  if (event.result.output.type !== "file" && event.result.output.type !== "text-page") return

  const candidate = {
    path: event.input.path,
    content: content.text,
    usesContentParts: content.usesParts,
    truncated: event.result.output.truncated === true,
    lines: content.text.split("\n").length,
  }
  return exceedsThreshold(candidate, config) ? candidate : undefined
}

export function buildSummaryPrompt(candidate: ReadCandidate, task: string, maxSummaryChars: number): string {
  return [
    "Analyze this file for the current task.",
    `Current task: ${task}`,
    `Return plain text with at most ${maxSummaryChars} characters.`,
    "Use short bullets. Start each bullet with an exact name, type, or line number.",
    "Include only facts that help with the current task.",
    "Do not invent missing code. State when the page ends before the file ends.",
    `Path: ${candidate.path}`,
    `Page truncated: ${candidate.truncated}`,
    "",
    candidate.content,
  ].join("\n")
}

export function createReplacement(
  originalChars: number,
  generatedText: string,
  maxSummaryChars: number,
  previous: SessionSavings,
): Replacement | undefined {
  const summary = generatedText.trim().slice(0, maxSummaryChars)
  if (!summary) return

  let savedChars = 0
  let text = ""
  for (let index = 0; index < 3; index++) {
    const session = {
      shunts: previous.shunts + 1,
      savedChars: previous.savedChars + savedChars,
    }
    text = [
      `[read-shunt: ${originalChars} chars reduced; ${Math.max(0, savedChars)} main-context chars avoided]`,
      `[session: ${session.shunts} shunts; about ${estimateTokens(session.savedChars)} main-context tokens avoided]`,
      "[exact follow-up reads with offset or limit bypass read-shunt]",
      summary,
    ].join("\n")
    savedChars = originalChars - text.length
  }
  if (savedChars <= 0) return

  const session = {
    shunts: previous.shunts + 1,
    savedChars: previous.savedChars + savedChars,
  }
  return {
    text,
    summaryChars: summary.length,
    replacementChars: text.length,
    savedChars,
    estimatedSavedTokens: estimateTokens(savedChars),
    session,
  }
}

export function applyReplacement(event: CompletedToolEvent, candidate: ReadCandidate, replacement: Replacement): void {
  event.result = {
    ...event.result,
    content: candidate.usesContentParts ? [{ type: "text", text: replacement.text }] : replacement.text,
    metadata: {
      ...event.result.metadata,
      readShunt: {
        originalChars: candidate.content.length,
        replacementChars: replacement.replacementChars,
        savedChars: replacement.savedChars,
        estimatedSavedTokens: replacement.estimatedSavedTokens,
        sessionShunts: replacement.session.shunts,
        sessionSavedChars: replacement.session.savedChars,
      },
    },
  }
}

export function parseSessionTask(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (isRecord(message) && message.type === "user" && typeof message.text === "string") {
      return message.text.slice(0, 2_000)
    }
  }
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`generation timed out after ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    return await Promise.race([operation, expired])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function parseTextContent(content: unknown): { text: string; usesParts: boolean } | undefined {
  if (typeof content === "string") return { text: content, usesParts: false }
  if (!Array.isArray(content) || content.length !== 1) return
  const part = content[0]
  if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return
  return { text: part.text, usesParts: true }
}

function exceedsThreshold(candidate: ReadCandidate, config: ReadShuntConfig): boolean {
  return candidate.lines > config.thresholdLines || candidate.content.length > config.thresholdChars
}

function isInstructionFile(path: string): boolean {
  const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase()
  return name === "agents.md" || name === "skill.md"
}

function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) return fallback
  return value
}
