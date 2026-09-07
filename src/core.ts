export type ShuntPolicyConfig = {
  thresholdChars: number
  thresholdLines: number
  maxSummaryChars: number
  generationTimeoutMs: number
}

export type ReadCandidate = {
  path: string
  content: string
  truncated: boolean
  lines: number
}

export type CandidateInput = {
  path: string
  content: string
  truncated?: boolean
  offset?: unknown
  limit?: unknown
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
} as const

export function resolvePolicyConfig(options: Readonly<Record<string, unknown>>): ShuntPolicyConfig {
  return {
    thresholdChars: positiveInteger(options.thresholdChars, defaults.thresholdChars),
    thresholdLines: positiveInteger(options.thresholdLines, defaults.thresholdLines),
    maxSummaryChars: positiveInteger(options.maxSummaryChars, defaults.maxSummaryChars),
    generationTimeoutMs: positiveInteger(options.generationTimeoutMs, defaults.generationTimeoutMs),
  }
}

export function selectCandidate(input: CandidateInput, config: ShuntPolicyConfig): ReadCandidate | undefined {
  if (!input.path || input.offset !== undefined || input.limit !== undefined) return
  if (isInstructionFile(input.path)) return

  const candidate = {
    path: input.path,
    content: input.content,
    truncated: input.truncated ?? false,
    lines: input.content.split("\n").length,
  }
  return exceedsThreshold(candidate, config) ? candidate : undefined
}

export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4))
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
      `[session estimate: ${session.shunts} shunts; about ${estimateTokens(session.savedChars)} main-context tokens avoided]`,
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

function exceedsThreshold(candidate: ReadCandidate, config: ShuntPolicyConfig): boolean {
  return candidate.lines > config.thresholdLines || candidate.content.length > config.thresholdChars
}

function isInstructionFile(path: string): boolean {
  const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase()
  return name === "agents.md" || name === "skill.md"
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback
}
