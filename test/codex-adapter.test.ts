import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SummaryRequest, SummaryResult, SummaryWorker } from "../src/contracts"
import { CodexAdapter } from "../src/codex/adapter"
import { codexCandidate, type CodexHookInput } from "../src/codex/candidate"
import { loadCodexConfig, resolveCodexConfig } from "../src/codex/config"
import { readCurrentTask } from "../src/codex/transcript"
import { buildCodexArguments, parseCodexOutput } from "../src/codex/worker"
import { CodexCliSummaryWorker } from "../src/codex/worker"

const largeOutput = "export function value() { return 42 }\n".repeat(500)

class FakeWorker implements SummaryWorker {
  readonly model = "openai/test-codex"

  async summarize(_request: SummaryRequest): Promise<SummaryResult> {
    return { text: "- `value`, line 1: returns 42" }
  }
}

async function config() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "read-shunt-codex-"))
  return resolveCodexConfig({
    HOME: stateDirectory,
    PLUGIN_DATA: stateDirectory,
    READ_SHUNT_THRESHOLD_CHARS: "100",
    READ_SHUNT_STATS_FILE: join(stateDirectory, "stats.jsonl"),
  })
}

function event(command = "cat src/large.ts", response: unknown = largeOutput) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    session_id: "thr_test",
    tool_input: { command },
    tool_response: response,
  }
}

describe("Codex adapter", () => {
  test("replaces a large broad read and records Codex savings", async () => {
    const settings = await config()
    const adapter = new CodexAdapter(settings, new FakeWorker())

    const output = await adapter.handle(event())

    expect(output?.decision).toBe("block")
    expect(output?.reason).toContain("`value`, line 1")
    expect(output?.reason).toContain("session estimate: 1 shunts")
    const entry = JSON.parse((await readFile(settings.statsFile, "utf8")).trim())
    expect(entry).toMatchObject({ host: "codex", model: "openai/test-codex", sessionShunts: 1 })
  })

  test("does not intercept OpenCode or unrelated Codex events", async () => {
    const settings = await config()
    const adapter = new CodexAdapter(settings, new FakeWorker())
    const cases: CodexHookInput[] = [
      { ...event(), hook_event_name: "PreToolUse" },
      { ...event(), tool_name: "apply_patch" },
      { ...event("rg value src/large.ts") },
      { ...event("cat src/large.ts | rg value") },
      { ...event("head -n 20 src/large.ts") },
      { ...event(), tool_response: "small" },
      { hook_event_name: "OpenCode", tool_response: largeOutput },
    ]

    for (const input of cases) expect(await adapter.handle(input)).toBeUndefined()
  })

  test("bypasses protected instruction files", async () => {
    const settings = await config()
    expect(codexCandidate(event("cat AGENTS.md"), settings)).toBeUndefined()
    expect(codexCandidate(event("cat path/to/SKILL.md"), settings)).toBeUndefined()
  })

  test("parses final Codex worker message", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "thr_worker" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "summary" } }),
    ].join("\n")
    expect(parseCodexOutput(output)).toBe("summary")
  })

  test("loads project JSON and applies environment overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "read-shunt-codex-config-"))
    const projectConfig = join(root, ".codex", "read-shunt.json")
    await mkdir(join(root, ".codex"))
    await Bun.write(projectConfig, JSON.stringify({ thresholdChars: 500, model: "gpt-5.6-luna" }))

    const settings = await loadCodexConfig(root, {
      HOME: root,
      PLUGIN_DATA: join(root, "plugin-data"),
      READ_SHUNT_THRESHOLD_CHARS: "700",
    })

    expect(settings.thresholdChars).toBe(700)
    expect(settings.codexModel).toBe("gpt-5.6-luna")
    expect(settings.reasoningEffort).toBe("low")
  })

  test("accepts supported Codex reasoning effort", () => {
    const settings = resolveCodexConfig({ READ_SHUNT_CODEX_REASONING_EFFORT: "minimal" })

    expect(settings.reasoningEffort).toBe("minimal")
    expect(buildCodexArguments(settings)).toContain('model_reasoning_effort="minimal"')
    expect(resolveCodexConfig({ READ_SHUNT_CODEX_REASONING_EFFORT: "invalid" }).reasoningEffort).toBe("low")
  })

  test("keeps generation inside the hook timeout", () => {
    expect(resolveCodexConfig({ READ_SHUNT_TIMEOUT_MS: "60000" }).generationTimeoutMs).toBe(40_000)
  })

  test("times out the complete Codex process lifecycle", async () => {
    const settings = resolveCodexConfig({
      READ_SHUNT_CODEX_COMMAND: join(import.meta.dir, "fixtures", "fake-codex-hang"),
    })
    const worker = new CodexCliSummaryWorker(settings)
    const startedAt = performance.now()

    await expect(worker.summarize(summaryRequest(30))).rejects.toThrow("generation timed out after 30 ms")
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })

  test("drains large Codex error output without deadlock", async () => {
    const settings = resolveCodexConfig({
      READ_SHUNT_CODEX_COMMAND: join(import.meta.dir, "fixtures", "fake-codex-stderr"),
    })
    const worker = new CodexCliSummaryWorker(settings)

    await expect(worker.summarize(summaryRequest(1_000))).rejects.toThrow()
  })

  test("skips malformed transcript lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "read-shunt-transcript-"))
    const path = join(root, "transcript.jsonl")
    await Bun.write(path, `${JSON.stringify({ role: "user", content: "Review exports." })}\ninvalid\n`)

    expect(await readCurrentTask(path)).toBe("Review exports.")
  })

  test("runs the Codex hook entry point with an isolated worker", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "read-shunt-codex-main-"))
    const fixture = join(import.meta.dir, "fixtures", "fake-codex")
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "codex", "main.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PLUGIN_DATA: stateDirectory,
        READ_SHUNT_CODEX_COMMAND: fixture,
        READ_SHUNT_THRESHOLD_CHARS: "100",
      },
    })
    child.stdin.write(JSON.stringify(event()))
    child.stdin.end()

    const output = JSON.parse(await new Response(child.stdout).text())
    expect(await child.exited).toBe(0)
    expect(output).toMatchObject({ decision: "block" })
    expect(output.reason).toContain("`value`, line 1")
  })
})

function summaryRequest(timeoutMs: number): SummaryRequest {
  return {
    candidate: { path: "large.ts", content: largeOutput, lines: 500, truncated: false },
    task: "Review exports.",
    maxSummaryChars: 4_000,
    timeoutMs,
  }
}
