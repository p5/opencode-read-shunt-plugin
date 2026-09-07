import { open } from "node:fs/promises"
import { isRecord } from "../core.js"

const transcriptTailBytes = 256 * 1024

export async function readCurrentTask(path: unknown): Promise<string | undefined> {
  if (typeof path !== "string") return
  try {
    const lines = (await readTail(path)).trimEnd().split("\n")
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]
      if (!line) continue
      try {
        const value: unknown = JSON.parse(line)
        const task = userText(value)
        if (task) return task.slice(0, 2_000)
      } catch {}
    }
  } catch {}
  return undefined
}

async function readTail(path: string): Promise<string> {
  const file = await open(path, "r")
  try {
    const { size } = await file.stat()
    const offset = Math.max(0, size - transcriptTailBytes)
    const buffer = Buffer.alloc(size - offset)
    await file.read(buffer, 0, buffer.length, offset)
    const text = buffer.toString("utf8")
    if (offset === 0) return text
    const firstLineEnd = text.indexOf("\n")
    return firstLineEnd < 0 ? "" : text.slice(firstLineEnd + 1)
  } finally {
    await file.close()
  }
}

function userText(value: unknown): string | undefined {
  if (!isRecord(value)) return
  if (value.role === "user") {
    if (typeof value.content === "string") return value.content
    if (Array.isArray(value.content)) {
      const text = value.content
        .filter(isRecord)
        .filter((part) => part.type === "input_text" || part.type === "text")
        .map((part) => part.text)
        .filter((part): part is string => typeof part === "string")
        .join("\n")
      if (text) return text
    }
  }
  for (const child of Object.values(value)) {
    const text = userText(child)
    if (text) return text
    if (!Array.isArray(child)) continue
    for (const item of child) {
      const nested = userText(item)
      if (nested) return nested
    }
  }
  return undefined
}
