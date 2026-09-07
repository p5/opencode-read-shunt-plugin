import { createReplacement, estimateTokens, type ShuntPolicyConfig } from "./core.js"
import type {
  HostName,
  SavingsEntry,
  SavingsLog,
  SessionSavingsStore,
  ShuntRequest,
  ShuntResult,
  SummaryWorker,
} from "./contracts.js"

export type ReadShuntOptions = {
  host: HostName
  policy: ShuntPolicyConfig
  sessions: SessionSavingsStore
  log: SavingsLog
}

export class ReadShunt {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly options: ReadShuntOptions) {}

  async run(request: ShuntRequest, worker: SummaryWorker): Promise<ShuntResult | undefined> {
    const startedAt = performance.now()
    const summary = await worker.summarize({
      candidate: request.candidate,
      task: request.task,
      maxSummaryChars: this.options.policy.maxSummaryChars,
      timeoutMs: this.options.policy.generationTimeoutMs,
    })

    return this.withSessionLock(request.sessionID, async () => {
      const replacement = await this.createAndSaveReplacement(request, summary.text)
      if (!replacement) return

      const entry: SavingsEntry = {
        time: new Date().toISOString(),
        host: this.options.host,
        sessionID: request.sessionID,
        path: request.candidate.path,
        model: worker.model,
        originalChars: request.candidate.content.length,
        originalLines: request.candidate.lines,
        summaryChars: replacement.summaryChars,
        replacementChars: replacement.replacementChars,
        savedChars: replacement.savedChars,
        estimatedSavedTokens: replacement.estimatedSavedTokens,
        sessionShunts: replacement.session.shunts,
        sessionSavedChars: replacement.session.savedChars,
        sessionEstimatedSavedTokens: estimateTokens(replacement.session.savedChars),
        latencyMs: Math.round(performance.now() - startedAt),
        workerUsage: summary.usage ?? "not reported",
      }

      await this.appendEntry(entry)
      return { replacement, entry }
    })
  }

  private async createAndSaveReplacement(request: ShuntRequest, summary: string) {
    try {
      return await this.options.sessions.update(request.sessionID, (current) => {
        const replacement = createReplacement(
          request.candidate.content.length,
          summary,
          this.options.policy.maxSummaryChars,
          current,
        )
        return { savings: replacement?.session ?? current, value: replacement }
      })
    } catch (error) {
      console.warn(`read-shunt could not update session statistics: ${errorMessage(error)}`)
      return createReplacement(
        request.candidate.content.length,
        summary,
        this.options.policy.maxSummaryChars,
        { shunts: 0, savedChars: 0 },
      )
    }
  }

  private async appendEntry(entry: SavingsEntry): Promise<void> {
    try {
      await this.options.log.append(entry)
    } catch (error) {
      console.warn(`read-shunt could not append the savings log: ${errorMessage(error)}`)
    }
  }

  private async withSessionLock<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionID) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    const lock = result.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(sessionID, lock)
    try {
      return await result
    } finally {
      if (this.locks.get(sessionID) === lock) this.locks.delete(sessionID)
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
