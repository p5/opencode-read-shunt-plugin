import type { SummaryWorker } from "../contracts.js"
import { ReadShunt } from "../read-shunt.js"
import { FileSessionSavingsStore, JsonlSavingsLog } from "../savings/file.js"
import { codexCandidate, type CodexHookInput } from "./candidate.js"
import type { CodexConfig } from "./config.js"
import { readCurrentTask } from "./transcript.js"
import { CodexCliSummaryWorker } from "./worker.js"

export type CodexHookOutput = {
  decision: "block"
  reason: string
}

export class CodexAdapter {
  private readonly shunt: ReadShunt

  constructor(
    private readonly config: CodexConfig,
    private readonly worker: SummaryWorker = new CodexCliSummaryWorker(config),
  ) {
    this.shunt = new ReadShunt({
      host: "codex",
      policy: config,
      sessions: new FileSessionSavingsStore(config.stateDirectory),
      log: new JsonlSavingsLog(config.statsFile),
    })
  }

  async handle(input: CodexHookInput): Promise<CodexHookOutput | undefined> {
    const candidate = codexCandidate(input, this.config)
    if (!candidate) return

    const result = await this.shunt.run({
      sessionID: textOr(input.session_id, "unknown"),
      task: (await readCurrentTask(input.transcript_path)) ?? "Understand the relevant code.",
      candidate,
    }, this.worker)
    if (!result) return

    console.error(
      `read-shunt saved about ${result.entry.estimatedSavedTokens} main-context tokens; ` +
        `session estimate about ${result.entry.sessionEstimatedSavedTokens}`,
    )
    return { decision: "block", reason: result.replacement.text }
  }
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}
