import { isRecord, selectCandidate, type ShuntPolicyConfig } from "../core.js"
import { parseBroadShellRead } from "../shell-read.js"

export type CodexHookInput = {
  session_id?: unknown
  transcript_path?: unknown
  cwd?: unknown
  hook_event_name?: unknown
  tool_name?: unknown
  tool_input?: unknown
  tool_response?: unknown
}

export function parseCodexHookInput(value: unknown): CodexHookInput | undefined {
  return isRecord(value) ? value : undefined
}

export function codexCandidate(input: CodexHookInput, config: ShuntPolicyConfig) {
  if (input.hook_event_name !== "PostToolUse" || input.tool_name !== "Bash") return
  if (!isRecord(input.tool_input) || typeof input.tool_input.command !== "string") return

  const read = parseBroadShellRead(input.tool_input.command)
  const content = textResponse(input.tool_response)
  if (!read || read.scope !== "full" || !content) return

  return selectCandidate({ path: read.path, content }, config)
}

function textResponse(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!isRecord(value)) return
  for (const key of ["output", "content", "text"] as const) {
    const content = value[key]
    if (typeof content === "string") return content
    if (!Array.isArray(content)) continue
    const text = content
      .filter(isRecord)
      .map((part) => part.text)
      .filter((part): part is string => typeof part === "string")
      .join("\n")
    if (text) return text
  }
  return undefined
}
