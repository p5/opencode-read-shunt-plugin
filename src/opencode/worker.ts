import type { Plugin } from "@opencode-ai/plugin"
import type { SummaryRequest, SummaryResult, SummaryWorker } from "../contracts.js"
import { buildStandaloneSummaryPrompt } from "../prompt.js"
import type { OpenCodeConfig } from "./config.js"

export class OpenCodeSummaryWorker implements SummaryWorker {
  readonly model: string

  constructor(
    private readonly generate: Plugin.Context["generate"],
    private readonly config: OpenCodeConfig,
  ) {
    this.model = `${config.model.providerID}/${config.model.id}`
  }

  async summarize(request: SummaryRequest): Promise<SummaryResult> {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new Error(`generation timed out after ${request.timeoutMs} ms`))
      }, request.timeoutMs)
    })
    try {
      const operation = this.generate.text(
        { prompt: buildStandaloneSummaryPrompt(request), model: this.config.model },
        { signal: controller.signal },
      )
      const generated = await Promise.race([operation, expired])
      return { text: generated.text }
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}
