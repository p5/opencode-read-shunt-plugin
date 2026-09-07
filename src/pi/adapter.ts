import { completeSimple } from "@earendil-works/pi-ai/compat"
import {
  isBashToolResult,
  isReadToolResult,
  type ExtensionContext,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent"
import type { HostAdapter, SummaryRequest, SummaryResult, SummaryWorker } from "../contracts.js"
import { isRecord, selectCandidate } from "../core.js"
import { FileSavingsStore } from "../file-savings-store.js"
import { ReadShuntService } from "../service.js"
import { parseBroadShellRead } from "../shell-read.js"
import type { PiConfig } from "./config.js"
import { buildPiPrompt, piSummarySystemPrompt } from "./prompt.js"

export type PiAdapterInput = {
  event: ToolResultEvent
  context: ExtensionContext
}

export type PiWorkerFactory = (context: ExtensionContext) => SummaryWorker

export type PiToolResultPatch = {
  content?: ToolResultEvent["content"]
  details?: unknown
  isError?: boolean
}

export class PiAdapter implements HostAdapter<PiAdapterInput, PiToolResultPatch | undefined> {
  readonly host = "pi" as const
  private readonly savings: FileSavingsStore

  constructor(
    private readonly config: PiConfig,
    private readonly workerFactory: PiWorkerFactory = (context) => new PiSummaryWorker(context, config),
  ) {
    this.savings = new FileSavingsStore(config.stateDirectory, config.statsFile)
  }

  async handle({ event, context }: PiAdapterInput): Promise<PiToolResultPatch | undefined> {
    const candidate = piCandidate(event, this.config)
    if (!candidate) return

    const worker = this.workerFactory(context)
    const service = new ReadShuntService(worker, this.savings)
    const result = await service.shunt({
      host: this.host,
      sessionID: context.sessionManager.getSessionId(),
      task: latestUserTask(context.sessionManager.getBranch()) ?? "Understand the relevant code.",
      candidate,
      config: this.config,
    })
    if (!result) return

    console.info(
      `read-shunt saved about ${result.entry.estimatedSavedTokens} main-context tokens; ` +
        `session total about ${result.entry.sessionEstimatedSavedTokens}`,
    )
    return { content: [{ type: "text", text: result.replacement.text }] }
  }
}

export function piCandidate(event: ToolResultEvent, config: PiConfig) {
  if (event.isError) return
  const content = textContent(event.content)
  if (!content) return

  if (isReadToolResult(event)) {
    const path = event.input.path
    if (typeof path !== "string") return
    return selectCandidate(
      {
        path,
        content,
        truncated: event.details?.truncation?.truncated,
        offset: event.input.offset,
        limit: event.input.limit,
      },
      config,
    )
  }

  if (isBashToolResult(event)) {
    const command = event.input.command
    if (typeof command !== "string") return
    const read = parseBroadShellRead(command)
    if (!read) return
    return selectCandidate(
      {
        path: read.path,
        content,
        truncated: event.details?.truncation?.truncated,
      },
      config,
    )
  }
}

class PiSummaryWorker implements SummaryWorker {
  readonly model: string

  constructor(
    private readonly context: ExtensionContext,
    private readonly config: PiConfig,
  ) {
    this.model = `${config.model.provider}/${config.model.id}`
  }

  async summarize(request: SummaryRequest): Promise<SummaryResult> {
    const model = this.context.modelRegistry.find(this.config.model.provider, this.config.model.id)
    if (!model) throw new Error(`Pi model is unavailable: ${this.model}`)

    const auth = await this.context.modelRegistry.getApiKeyAndHeaders(model)
    if (!auth.ok) throw new Error(`Pi model authentication failed: ${auth.error}`)

    const controller = new AbortController()
    const abort = () => controller.abort(this.context.signal?.reason)
    this.context.signal?.addEventListener("abort", abort, { once: true })
    try {
      const response = await withAbortTimeout(
        completeSimple(
          model,
          {
            systemPrompt: piSummarySystemPrompt,
            messages: [
              {
                role: "user",
                content: buildPiPrompt(request),
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            maxTokens: Math.max(256, Math.ceil(request.maxSummaryChars / 2)),
            reasoning: this.config.reasoningEffort,
            signal: controller.signal,
          },
        ),
        controller,
        request.timeoutMs,
      )
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
          reasoningTokens: response.usage.reasoning,
          cacheReadTokens: response.usage.cacheRead,
          cacheWriteTokens: response.usage.cacheWrite,
          cost: response.usage.cost.total,
        },
      }
    } finally {
      this.context.signal?.removeEventListener("abort", abort)
    }
  }
}

async function withAbortTimeout<T>(
  operation: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new Error(`generation timed out after ${timeoutMs} ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation, expired])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function textContent(content: ToolResultEvent["content"]): string | undefined {
  const textParts = content.filter(
    (part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text",
  )
  if (textParts.length !== content.length) return
  const text = textParts.map((part) => part.text).join("\n")
  return text || undefined
}

function latestUserTask(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue
    if (entry.message.role !== "user") continue
    const content = entry.message.content
    if (typeof content === "string") return content.slice(0, 2_000)
    if (!Array.isArray(content)) continue
    const text = content
      .filter(isRecord)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .filter((part): part is string => typeof part === "string")
      .join("\n")
    if (text) return text.slice(0, 2_000)
  }
}
