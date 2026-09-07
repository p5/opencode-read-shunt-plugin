import { mkdir, appendFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Plugin } from "@opencode-ai/plugin"
import {
  applyReplacement,
  buildSummaryPrompt,
  createReplacement,
  parseSessionTask,
  readCandidate,
  resolveConfig,
  withTimeout,
  type CompletedToolEvent,
  type ReadCandidate,
  type ReadShuntConfig,
  type Replacement,
  type SessionSavings,
} from "./core.js"

const plugin = Plugin.define({
  id: "ReadShunt",
  setup: async (context) => {
    const config = resolveConfig(context.options)
    await context.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      try {
        await handleReadEvent(event, config, context)
      } catch (error) {
        console.warn(`read-shunt failed open: ${errorMessage(error)}`)
      }
    })
  },
})

type ReadShuntServices = Pick<Plugin.Context, "generate" | "session" | "storage">

async function handleReadEvent(
  event: CompletedToolEvent,
  config: ReadShuntConfig,
  services: ReadShuntServices,
): Promise<void> {
  const candidate = readCandidate(event, config)
  if (!candidate) return

  const messages = await services.session.context({ sessionID: event.sessionID })
  const task = parseSessionTask(messages)
  if (!task) return

  const startedAt = performance.now()
  const generated = await withTimeout(
    services.generate.text({
      prompt: buildSummaryPrompt(candidate, task, config.maxSummaryChars),
      model: config.model,
    }),
    config.generationTimeoutMs,
  )
  const previous = await loadSessionSavings(services.storage.get, event.sessionID)
  const replacement = createReplacement(candidate.content.length, generated.text, config.maxSummaryChars, previous)
  if (!replacement) return

  applyReplacement(event, candidate, replacement)
  const stat = buildStat(event.sessionID, candidate, replacement, config, startedAt)
  await recordSavings(services.storage, config.statsFile, replacement, stat)
}

function buildStat(
  sessionID: string,
  candidate: ReadCandidate,
  replacement: Replacement,
  config: ReadShuntConfig,
  startedAt: number,
) {
  return {
    time: new Date().toISOString(),
    sessionID,
    path: candidate.path,
    model: `${config.model.providerID}/${config.model.id}`,
    originalChars: candidate.content.length,
    originalLines: candidate.lines,
    summaryChars: replacement.summaryChars,
    replacementChars: replacement.replacementChars,
    savedChars: replacement.savedChars,
    estimatedSavedTokens: replacement.estimatedSavedTokens,
    sessionShunts: replacement.session.shunts,
    sessionSavedChars: replacement.session.savedChars,
    sessionEstimatedSavedTokens: Math.round(replacement.session.savedChars / 4),
    latencyMs: Math.round(performance.now() - startedAt),
    workerUsage: "not reported by generation API",
  }
}

async function recordSavings(
  storage: Plugin.Context["storage"],
  statsFile: string,
  replacement: Replacement,
  stat: ReturnType<typeof buildStat>,
): Promise<void> {
  try {
    await storage.set(sessionKey(stat.sessionID), replacement.session)
  } catch (error) {
    console.warn(`read-shunt could not store session statistics: ${errorMessage(error)}`)
  }

  console.info(
    `read-shunt saved about ${replacement.estimatedSavedTokens} main-context tokens; session total about ${stat.sessionEstimatedSavedTokens}`,
  )
  try {
    await appendStat(statsFile, stat)
  } catch (error) {
    console.warn(`read-shunt could not write statistics: ${errorMessage(error)}`)
  }
}

async function loadSessionSavings(
  get: (key: string) => Promise<unknown>,
  sessionID: string,
): Promise<SessionSavings> {
  try {
    const value = await get(sessionKey(sessionID))
    if (
      typeof value === "object" &&
      value !== null &&
      "shunts" in value &&
      "savedChars" in value &&
      typeof value.shunts === "number" &&
      typeof value.savedChars === "number"
    ) {
      return { shunts: value.shunts, savedChars: value.savedChars }
    }
  } catch (error) {
    console.warn(`read-shunt could not load session statistics: ${errorMessage(error)}`)
  }
  return { shunts: 0, savedChars: 0 }
}

async function appendStat(path: string, value: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

function sessionKey(sessionID: string): string {
  return `read-shunt/session/${sessionID}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default plugin
export * from "./core.js"
