import type { ReadCandidate, Replacement, SessionSavings, ShuntPolicyConfig } from "./core.js"

export type HostName = "codex" | "opencode"

export interface HostAdapter<TInput, TOutput> {
  readonly host: HostName
  handle(input: TInput): Promise<TOutput>
}

export type SummaryRequest = {
  candidate: ReadCandidate
  task: string
  maxSummaryChars: number
  timeoutMs: number
}

export interface SummaryWorker {
  readonly model: string
  summarize(request: SummaryRequest): Promise<string>
}

export interface SavingsStore {
  load(sessionID: string): Promise<SessionSavings>
  save(sessionID: string, savings: SessionSavings): Promise<void>
  record(entry: SavingsEntry): Promise<void>
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
  workerUsage: string
}

export type ShuntRequest = {
  host: HostName
  sessionID: string
  task: string
  candidate: ReadCandidate
  config: ShuntPolicyConfig
}

export type ShuntResult = {
  replacement: Replacement
  entry: SavingsEntry
}
