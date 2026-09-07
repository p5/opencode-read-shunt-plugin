import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { ShuntPolicyConfig } from "../core.js"
import type { OpenCodeConfig } from "./config.js"
import { bashReadPath, type BeforeToolEvent } from "./events.js"

export async function guardBashRead(
  event: BeforeToolEvent,
  config: OpenCodeConfig,
  directory: string,
): Promise<void> {
  const inputPath = bashReadPath(event, config)
  if (!inputPath) return
  const path = isAbsolute(inputPath) ? inputPath : resolve(directory, inputPath)
  try {
    const info = await stat(path)
    if (!info.isFile() || !(await exceedsThreshold(path, config))) return
  } catch {
    return
  }
  throw new Error(
    `read-shunt blocked ${event.tool}: ${inputPath} exceeds a configured threshold. ` +
      "Use the read tool without offset or limit so ReadShunt can summarize it. " +
      "Use a targeted pipeline or redirected command when exact output is required.",
  )
}

async function exceedsThreshold(path: string, policy: ShuntPolicyConfig): Promise<boolean> {
  let chars = 0
  let lines = 1
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    chars += chunk.length
    if (chars > policy.thresholdChars) return true
    for (const character of chunk) {
      if (character === "\n" && ++lines > policy.thresholdLines) return true
    }
  }
  return false
}
