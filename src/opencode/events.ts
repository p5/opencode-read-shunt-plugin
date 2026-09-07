import { isRecord, selectCandidate, type ReadCandidate, type Replacement } from "../core.js"
import { parseBroadShellRead } from "../shell-read.js"
import type { OpenCodeConfig } from "./config.js"
import type { BeforeToolEvent, CompletedToolEvent } from "./contracts.js"

export type { BeforeToolEvent, CompletedToolEvent } from "./contracts.js"

export type OpenCodeCandidate = {
  candidate: ReadCandidate
  usesContentParts: boolean
}

export function readCandidate(event: CompletedToolEvent, config: OpenCodeConfig): OpenCodeCandidate | undefined {
  if (event.tool !== "read" || !config.allowedAgents.includes(event.agent)) return
  if (!isRecord(event.input) || typeof event.input.path !== "string" || event.input.path.length === 0) return
  const content = parseTextContent(event.result.content)
  if (!content || !isRecord(event.result.output)) return
  if (event.result.output.encoding === "base64") return
  if (event.result.output.type !== "file" && event.result.output.type !== "text-page") return

  const candidate = selectCandidate(
    {
      path: event.input.path,
      content: content.text,
      truncated: event.result.output.truncated === true,
      offset: event.input.offset,
      limit: event.input.limit,
    },
    config,
  )
  return candidate ? { candidate, usesContentParts: content.usesParts } : undefined
}

export function bashReadPath(event: BeforeToolEvent, config: OpenCodeConfig): string | undefined {
  if (event.tool !== "bash" || !config.allowedAgents.includes(event.agent)) return
  if (!isRecord(event.input) || typeof event.input.command !== "string") return

  return parseBroadShellRead(event.input.command)?.path
}

export function applyReplacement(
  event: CompletedToolEvent,
  candidate: OpenCodeCandidate,
  replacement: Replacement,
): void {
  event.result = {
    ...event.result,
    content: candidate.usesContentParts ? [{ type: "text", text: replacement.text }] : replacement.text,
    metadata: {
      ...event.result.metadata,
      readShunt: {
        originalChars: candidate.candidate.content.length,
        replacementChars: replacement.replacementChars,
        savedChars: replacement.savedChars,
        estimatedSavedTokens: replacement.estimatedSavedTokens,
        sessionShunts: replacement.session.shunts,
        sessionSavedChars: replacement.session.savedChars,
      },
    },
  }
}

export function parseSessionTask(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (isRecord(message) && message.type === "user" && typeof message.text === "string") {
      return message.text.slice(0, 2_000)
    }
  }
  return undefined
}

function parseTextContent(content: unknown): { text: string; usesParts: boolean } | undefined {
  if (typeof content === "string") return { text: content, usesParts: false }
  if (!Array.isArray(content) || content.length !== 1) return
  const part = content[0]
  if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return
  return { text: part.text, usesParts: true }
}
