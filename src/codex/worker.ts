import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SummaryRequest, SummaryResult, SummaryWorker } from "../contracts.js"
import type { CodexConfig } from "./config.js"
import { buildStandaloneSummaryPrompt } from "../prompt.js"

export class CodexCliSummaryWorker implements SummaryWorker {
  readonly model: string

  constructor(private readonly config: CodexConfig) {
    this.model = `openai/${config.codexModel}`
  }

  async summarize(request: SummaryRequest): Promise<SummaryResult> {
    const workingDirectory = await mkdtemp(join(tmpdir(), "read-shunt-worker-"))
    try {
      return await this.run(request, workingDirectory)
    } finally {
      await rm(workingDirectory, { recursive: true, force: true })
    }
  }

  private async run(request: SummaryRequest, workingDirectory: string): Promise<SummaryResult> {
    const child = Bun.spawn(buildCodexArguments(this.config), {
      cwd: workingDirectory,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(buildStandaloneSummaryPrompt(request))
    child.stdin.end()

    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutError = new Error(`generation timed out after ${request.timeoutMs} ms`)
    try {
      const expired = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(timeoutError), request.timeoutMs)
      })
      const operation = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const [output, errorOutput, exitCode] = await Promise.race([operation, expired])
      if (exitCode !== 0) {
        const error = errorOutput.trim()
        throw new Error(error || `codex worker exited with ${exitCode}`)
      }
      const message = parseCodexOutput(output)
      if (!message) throw new Error("codex worker returned no agent message")
      return { text: message }
    } catch (error) {
      if (error === timeoutError) await terminate(child)
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}

async function terminate(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  child.kill("SIGTERM")
  const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(250).then(() => false)])
  if (stopped) return
  child.kill("SIGKILL")
  await child.exited
}

export function buildCodexArguments(config: CodexConfig): string[] {
  return [
    config.codexCommand,
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    config.codexModel,
    "--config",
    `model_reasoning_effort="${config.reasoningEffort}"`,
    "--json",
    "-",
  ]
}

export function parseCodexOutput(output: string): string | undefined {
  let message: string | undefined
  for (const line of output.split("\n")) {
    try {
      const event: unknown = JSON.parse(line)
      if (!isAgentMessage(event)) continue
      message = event.item.text
    } catch {}
  }
  return message
}

function isAgentMessage(value: unknown): value is {
  type: "item.completed"
  item: { type: "agent_message"; text: string }
} {
  if (typeof value !== "object" || value === null || !("type" in value) || !("item" in value)) return false
  if (value.type !== "item.completed" || typeof value.item !== "object" || value.item === null) return false
  return (
    "type" in value.item &&
    "text" in value.item &&
    value.item.type === "agent_message" &&
    typeof value.item.text === "string"
  )
}
