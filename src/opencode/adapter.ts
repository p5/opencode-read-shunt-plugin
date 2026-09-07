import type { Plugin } from "@opencode-ai/plugin"
import { ReadShunt } from "../read-shunt.js"
import { JsonlSavingsLog } from "../savings/file.js"
import { guardBashRead } from "./bash-guard.js"
import { resolveOpenCodeConfig, type OpenCodeConfig } from "./config.js"
import { applyReplacement, parseSessionTask, readCandidate } from "./events.js"
import { OpenCodeSessionSavingsStore } from "./savings.js"
import { OpenCodeSummaryWorker } from "./worker.js"

type OpenCodeToolEvent = Parameters<Parameters<Plugin.Context["tool"]["hook"]>[1]>[0]

export class OpenCodeAdapter {
  private readonly config: OpenCodeConfig
  private readonly shunt: ReadShunt
  private readonly worker: OpenCodeSummaryWorker

  constructor(private readonly context: Plugin.Context) {
    this.config = resolveOpenCodeConfig(context.options)
    this.worker = new OpenCodeSummaryWorker(context.generate, this.config)
    this.shunt = new ReadShunt({
      host: "opencode",
      policy: this.config,
      sessions: new OpenCodeSessionSavingsStore(context.storage),
      log: new JsonlSavingsLog(this.config.statsFile),
    })
  }

  async install(): Promise<void> {
    await this.context.tool.hook("execute.before", async (event) => {
      await guardBashRead(event, this.config, this.context.location.directory)
    })
    await this.context.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      try {
        await this.handle(event)
      } catch (error) {
        console.warn(`read-shunt failed open: ${errorMessage(error)}`)
      }
    })
  }

  async handle(event: OpenCodeToolEvent): Promise<void> {
    if (!("status" in event) || event.status !== "completed") return
    const selected = readCandidate(event, this.config)
    if (!selected) return

    const messages = await this.context.session.context({ sessionID: event.sessionID })
    const task = parseSessionTask(messages)
    if (!task) return
    const result = await this.shunt.run({ sessionID: event.sessionID, task, candidate: selected.candidate }, this.worker)
    if (!result) return

    applyReplacement(event, selected, result.replacement)
    console.info(
      `read-shunt saved about ${result.entry.estimatedSavedTokens} main-context tokens; ` +
        `session estimate about ${result.entry.sessionEstimatedSavedTokens}`,
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
