import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { SummaryRequest, SummaryResult, SummaryWorker } from "../contracts.js"
import { buildSummaryPrompt, summarySystemPrompt } from "../prompt.js"
import type { PiConfig } from "./config.js"
import { piGenerationClient, type PiGenerationClient } from "./generation.js"

export class PiSummaryWorker implements SummaryWorker {
  readonly model: string

  constructor(
    private readonly context: ExtensionContext,
    private readonly config: PiConfig,
    private readonly generation: PiGenerationClient = piGenerationClient,
  ) {
    this.model = `${config.model.provider}/${config.model.id}`
  }

  async summarize(request: SummaryRequest): Promise<SummaryResult> {
    const deadline = createDeadline(this.context.signal, request.timeoutMs)
    try {
      const model = this.context.modelRegistry.find(this.config.model.provider, this.config.model.id)
      if (!model) throw new Error(`Pi model is unavailable: ${this.model}`)
      const auth = await Promise.race([
        this.context.modelRegistry.getApiKeyAndHeaders(model),
        deadline.cancellation,
      ])
      if (!auth.ok) throw new Error(`Pi model authentication failed: ${auth.error}`)

      const response = await Promise.race([
        this.generation.complete(
          model,
          {
            systemPrompt: summarySystemPrompt,
            messages: [{ role: "user", content: buildSummaryPrompt(request), timestamp: Date.now() }],
          },
          {
            ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
            ...(auth.headers === undefined ? {} : { headers: auth.headers }),
            ...(auth.env === undefined ? {} : { env: auth.env }),
            maxTokens: Math.max(256, Math.ceil(request.maxSummaryChars / 2)),
            reasoning: this.config.reasoningEffort,
            signal: deadline.signal,
          },
        ),
        deadline.cancellation,
      ])
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage ?? `Pi worker stopped: ${response.stopReason}`)
      }
      const text = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      return {
        text,
        usage: {
          inputTokens: response.usage.input,
          outputTokens: response.usage.output,
          ...(response.usage.reasoning === undefined
            ? {}
            : { reasoningTokens: response.usage.reasoning }),
          cacheReadTokens: response.usage.cacheRead,
          cacheWriteTokens: response.usage.cacheWrite,
          cost: response.usage.cost.total,
        },
      }
    } finally {
      deadline.dispose()
    }
  }
}

function createDeadline(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let rejectCancellation: (reason: Error) => void = () => {}
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject
  })
  const abort = (reason: unknown) => {
    if (controller.signal.aborted) return
    const error = reason instanceof Error ? reason : new Error("Pi worker aborted")
    controller.abort(error)
    rejectCancellation(error)
  }
  const onParentAbort = () => abort(parent?.reason)
  const timeout = setTimeout(() => abort(new Error(`generation timed out after ${timeoutMs} ms`)), timeoutMs)
  if (parent?.aborted) onParentAbort()
  else parent?.addEventListener("abort", onParentAbort, { once: true })
  return {
    cancellation,
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      parent?.removeEventListener("abort", onParentAbort)
    },
  }
}
