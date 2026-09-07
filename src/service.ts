import { createReplacement, estimateTokens } from "./core.js"
import type { SavingsEntry, SavingsStore, ShuntRequest, ShuntResult, SummaryWorker } from "./contracts.js"

export class ReadShuntService {
  constructor(
    private readonly worker: SummaryWorker,
    private readonly savings: SavingsStore,
  ) {}

  async shunt(request: ShuntRequest): Promise<ShuntResult | undefined> {
    const startedAt = performance.now()
    const summary = await this.worker.summarize({
      candidate: request.candidate,
      task: request.task,
      maxSummaryChars: request.config.maxSummaryChars,
      timeoutMs: request.config.generationTimeoutMs,
    })
    const previous = await this.savings.load(request.sessionID)
    const replacement = createReplacement(
      request.candidate.content.length,
      summary.text,
      request.config.maxSummaryChars,
      previous,
    )
    if (!replacement) return

    const entry: SavingsEntry = {
      time: new Date().toISOString(),
      host: request.host,
      sessionID: request.sessionID,
      path: request.candidate.path,
      model: this.worker.model,
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

    const writes = await Promise.allSettled([
      this.savings.save(request.sessionID, replacement.session),
      this.savings.record(entry),
    ])
    for (const write of writes) {
      if (write.status === "rejected") console.warn(`read-shunt could not record savings: ${errorMessage(write.reason)}`)
    }
    return { replacement, entry }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
