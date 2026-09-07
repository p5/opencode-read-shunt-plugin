import { createReadStream } from "node:fs"
import { appendFile, mkdir, stat } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import type {
  HostAdapter,
  SavingsEntry,
  SavingsStore,
  SummaryRequest,
  SummaryResult,
  SummaryWorker,
} from "../contracts.js"
import {
  withTimeout,
  type SessionSavings,
} from "../core.js"
import { ReadShuntService } from "../service.js"
import { resolveOpenCodeConfig, type OpenCodeConfig } from "./config.js"
import {
  applyReplacement,
  bashReadPath,
  parseSessionTask,
  readCandidate,
  type BeforeToolEvent,
  type CompletedToolEvent,
} from "./events.js"
import { buildOpenCodePrompt } from "./prompt.js"

type OpenCodeToolEvent = Parameters<Parameters<Plugin.Context["tool"]["hook"]>[1]>[0]

export class OpenCodeAdapter implements HostAdapter<OpenCodeToolEvent, void> {
  readonly host = "opencode" as const
  private readonly config: OpenCodeConfig
  private readonly service: ReadShuntService

  constructor(private readonly context: Plugin.Context) {
    this.config = resolveOpenCodeConfig(context.options)
    this.service = new ReadShuntService(
      new OpenCodeSummaryWorker(context.generate, this.config),
      new OpenCodeSavingsStore(context.storage, this.config.statsFile),
    )
  }

  async install(): Promise<void> {
    await this.context.tool.hook("execute.before", async (event) => this.guardBashRead(event))
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
    const selected = readCandidate(event as CompletedToolEvent, this.config)
    if (!selected) return

    const messages = await this.context.session.context({ sessionID: event.sessionID })
    const task = parseSessionTask(messages)
    if (!task) return

    const result = await this.service.shunt({
      host: this.host,
      sessionID: event.sessionID,
      task,
      candidate: selected.candidate,
      config: this.config,
    })
    if (!result) return

    applyReplacement(event as CompletedToolEvent, selected, result.replacement)
    console.info(
      `read-shunt saved about ${result.entry.estimatedSavedTokens} main-context tokens; ` +
        `session total about ${result.entry.sessionEstimatedSavedTokens}`,
    )
  }

  private async guardBashRead(event: BeforeToolEvent): Promise<void> {
    const inputPath = bashReadPath(event, this.config)
    if (!inputPath) return

    const path = isAbsolute(inputPath) ? inputPath : resolve(this.context.location.directory, inputPath)
    try {
      const info = await stat(path)
      if (!info.isFile() || !(await exceedsLineThreshold(path, this.config.thresholdLines))) return
    } catch {
      return
    }

    throw new Error(
      `read-shunt blocked ${event.tool}: ${inputPath} exceeds ${this.config.thresholdLines} lines. ` +
        "Use the read tool without offset or limit so ReadShunt can summarize it. " +
        "Use a targeted pipeline or redirected command when exact output is required.",
    )
  }
}

class OpenCodeSummaryWorker implements SummaryWorker {
  readonly model: string

  constructor(
    private readonly generate: Plugin.Context["generate"],
    private readonly config: OpenCodeConfig,
  ) {
    this.model = `${config.model.providerID}/${config.model.id}`
  }

  async summarize(request: SummaryRequest): Promise<SummaryResult> {
    const generated = await withTimeout(
      this.generate.text({
        prompt: buildOpenCodePrompt(request),
        model: this.config.model,
      }),
      request.timeoutMs,
    )
    return { text: generated.text }
  }
}

class OpenCodeSavingsStore implements SavingsStore {
  constructor(
    private readonly storage: Plugin.Context["storage"],
    private readonly statsFile: string,
  ) {}

  async load(sessionID: string): Promise<SessionSavings> {
    try {
      const value = await this.storage.get(sessionKey(sessionID))
      if (isSavings(value)) return value
    } catch (error) {
      console.warn(`read-shunt could not load session statistics: ${errorMessage(error)}`)
    }
    return { shunts: 0, savedChars: 0 }
  }

  async save(sessionID: string, savings: SessionSavings): Promise<void> {
    try {
      await this.storage.set(sessionKey(sessionID), savings)
    } catch (error) {
      console.warn(`read-shunt could not store session statistics: ${errorMessage(error)}`)
    }
  }

  async record(entry: SavingsEntry): Promise<void> {
    try {
      await mkdir(dirname(this.statsFile), { recursive: true, mode: 0o700 })
      await appendFile(this.statsFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch (error) {
      console.warn(`read-shunt could not write statistics: ${errorMessage(error)}`)
    }
  }
}

async function exceedsLineThreshold(path: string, threshold: number): Promise<boolean> {
  let lines = 0
  for await (const chunk of createReadStream(path)) {
    for (const byte of chunk) {
      if (byte === 10 && ++lines > threshold) return true
    }
  }
  return false
}

function isSavings(value: unknown): value is SessionSavings {
  return (
    typeof value === "object" &&
    value !== null &&
    "shunts" in value &&
    "savedChars" in value &&
    typeof value.shunts === "number" &&
    typeof value.savedChars === "number"
  )
}

function sessionKey(sessionID: string): string {
  return `read-shunt/session/${sessionID}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
