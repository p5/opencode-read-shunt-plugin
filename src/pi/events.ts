import {
  isBashToolResult,
  isReadToolResult,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent"
import { isRecord, selectCandidate, type ShuntPolicyConfig } from "../core.js"
import { parseBroadShellRead } from "../shell-read.js"

export function piCandidate(event: ToolResultEvent, config: ShuntPolicyConfig) {
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
        ...(event.details?.truncation?.truncated === undefined
          ? {}
          : { truncated: event.details.truncation.truncated }),
        offset: event.input.offset,
        limit: event.input.limit,
      },
      config,
    )
  }

  if (!isBashToolResult(event)) return
  const command = event.input.command
  if (typeof command !== "string") return
  const read = parseBroadShellRead(command)
  if (!read || read.scope !== "full") return
  return selectCandidate(
    {
      path: read.path,
      content,
      ...(event.details?.truncation?.truncated === undefined
        ? {}
        : { truncated: event.details.truncation.truncated }),
    },
    config,
  )
}

export function latestUserTask(entries: readonly unknown[]): string | undefined {
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
  return undefined
}

function textContent(content: ToolResultEvent["content"]): string | undefined {
  const textParts = content.filter(
    (part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text",
  )
  if (textParts.length !== content.length) return
  const text = textParts.map((part) => part.text).join("\n")
  return text || undefined
}
