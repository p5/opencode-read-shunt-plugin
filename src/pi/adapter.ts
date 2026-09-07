import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import type { SummaryWorker } from "../contracts.js"
import { ReadShunt } from "../read-shunt.js"
import { FileSessionSavingsStore, JsonlSavingsLog } from "../savings/file.js"
import type { PiConfig } from "./config.js"
import { latestUserTask, piCandidate } from "./events.js"
import { PiSummaryWorker } from "./worker.js"

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

export class PiAdapter {
  private readonly shunt: ReadShunt

  constructor(
    private readonly config: PiConfig,
    private readonly workerFactory: PiWorkerFactory = (context) => new PiSummaryWorker(context, config),
  ) {
    this.shunt = new ReadShunt({
      host: "pi",
      policy: config,
      sessions: new FileSessionSavingsStore(config.stateDirectory),
      log: new JsonlSavingsLog(config.statsFile),
    })
  }

  async handle({ event, context }: PiAdapterInput): Promise<PiToolResultPatch | undefined> {
    const candidate = piCandidate(event, this.config)
    if (!candidate) return

    const result = await this.shunt.run(
      {
        sessionID: context.sessionManager.getSessionId(),
        task: latestUserTask(context.sessionManager.getBranch()) ?? "Understand the relevant code.",
        candidate,
      },
      this.workerFactory(context),
    )
    if (!result) return

    console.info(
      `read-shunt saved about ${result.entry.estimatedSavedTokens} main-context tokens; ` +
        `session estimate about ${result.entry.sessionEstimatedSavedTokens}`,
    )
    return { content: [{ type: "text", text: result.replacement.text }] }
  }
}
