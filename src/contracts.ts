import type { ReadCandidate, Replacement, SessionSavings } from "./core.js"

export type HostName = "codex" | "opencode" | "pi"

export type SummaryRequest = {
  candidate: ReadCandidate
  task: string
  maxSummaryChars: number
  timeoutMs: number
}

export interface SummaryWorker {
  readonly model: string
  summarize(request: SummaryRequest): Promise<SummaryResult>
}

export type SummaryResult = {
  text: string
  usage?: WorkerUsage
}

export type WorkerUsage = {
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: number
}

export interface SessionSavingsStore {
  update<T>(
    sessionID: string,
    operation: (current: SessionSavings) => { savings: SessionSavings; value: T },
  ): Promise<T>
}

export interface SavingsLog {
  append(entry: SavingsEntry): Promise<void>
}

export type SavingsEntry = {
  time: string
  host: HostName
  sessionID: string
  path: string
  model: string
  originalChars: number
  originalLines: number
  summaryChars: number
  replacementChars: number
  savedChars: number
  estimatedSavedTokens: number
  sessionShunts: number
  sessionSavedChars: number
  sessionEstimatedSavedTokens: number
  latencyMs: number
  workerUsage: WorkerUsage | "not reported"
}

export type ShuntRequest = {
  sessionID: string
  task: string
  candidate: ReadCandidate
}

export type ShuntResult = {
  replacement: Replacement
  entry: SavingsEntry
}
