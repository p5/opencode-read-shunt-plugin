import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import readShunt from "../src/index"

type ToolHookCallback = Parameters<Plugin.Context["tool"]["hook"]>[1]
type ToolHookEvent = Parameters<ToolHookCallback>[0]
type CompletedToolHookEvent = Extract<ToolHookEvent, { status: "completed" }>
type FailedToolHookEvent = Extract<ToolHookEvent, { status: "error" }>

const largeContent = "export function value() { return 42 }\n".repeat(500)

type HarnessOptions = {
  plugin?: Readonly<Record<string, unknown>>
  generate?: () => Promise<{ text: string }>
  storageGet?: (key: string) => Promise<unknown>
  storageSet?: (key: string, value: unknown) => Promise<void>
}

async function setupHarness(options: HarnessOptions = {}) {
  let after: ToolHookCallback | undefined
  let sessionCalls = 0
  const stored = new Map<string, unknown>()
  const context = {
    options: {
      thresholdChars: 100,
      allowedAgents: ["explore"],
      statsFile: "/dev/null",
      ...options.plugin,
    },
    tool: {
      hook: async (name: string, callback: ToolHookCallback) => {
        expect(name).toBe("execute.after")
        after = callback
      },
    },
    session: {
      context: async () => {
        sessionCalls++
        return [{ type: "user", text: "Explain exported functions" }]
      },
    },
    generate: { text: options.generate ?? (async () => ({ text: "value, line 1" })) },
    storage: {
      get: options.storageGet ?? (async (key: string) => stored.get(key)),
      set: options.storageSet ?? (async (key: string, value: unknown) => void stored.set(key, value)),
    },
  } as unknown as Plugin.Context

  await readShunt.setup(context)
  return {
    run: async (event: ToolHookEvent) => after!(event),
    sessionCalls: () => sessionCalls,
    stored,
  }
}

function completedEvent(
  options: {
    tool?: string
    agent?: string
    input?: Record<string, unknown>
    content?: string
    sessionID?: string
  } = {},
) {
  return {
    tool: options.tool ?? "read",
    sessionID: (options.sessionID ?? "ses_contract") as CompletedToolHookEvent["sessionID"],
    agent: (options.agent ?? "explore") as CompletedToolHookEvent["agent"],
    messageID: "msg_contract" as CompletedToolHookEvent["messageID"],
    id: crypto.randomUUID() as CompletedToolHookEvent["id"],
    status: "completed" as const,
    input: options.input ?? { path: "src/large.ts" },
    result: {
      output: { type: "file", encoding: "utf8", truncated: false },
      content: [{ type: "text" as const, text: options.content ?? largeContent }],
      metadata: {},
    },
  } satisfies CompletedToolHookEvent
}

function failedEvent() {
  return {
    tool: "read",
    sessionID: "ses_failed" as FailedToolHookEvent["sessionID"],
    agent: "explore" as FailedToolHookEvent["agent"],
    messageID: "msg_failed" as FailedToolHookEvent["messageID"],
    id: "call_failed" as FailedToolHookEvent["id"],
    status: "error" as const,
    input: { path: "missing.ts" },
    error: { message: "read failed" } as FailedToolHookEvent["error"],
  } satisfies FailedToolHookEvent
}

function visibleText(event: ReturnType<typeof completedEvent>): string {
  return event.result.content[0]!.text
}

describe("OpenCode Promise plugin contract", () => {
  test("handles official events and accumulates session savings", async () => {
    const statsRoot = await mkdtemp(join(tmpdir(), "read-shunt-test-"))
    const statsFile = join(statsRoot, "nested", "stats.jsonl")
    const harness = await setupHarness({ plugin: { statsFile } })
    const first = completedEvent()
    const second = completedEvent()

    await harness.run(first)
    await harness.run(second)

    expect(visibleText(first)).toContain("session: 1 shunts")
    expect(visibleText(second)).toContain("session: 2 shunts")
    expect(harness.sessionCalls()).toBe(2)
    expect(harness.stored.get("read-shunt/session/ses_contract")).toMatchObject({ shunts: 2 })
    const stats = (await readFile(statsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(stats).toHaveLength(2)
    expect(stats[1]).toMatchObject({ sessionShunts: 2 })
  })

  test("rejects irrelevant events before session lookup", async () => {
    const harness = await setupHarness()
    const events: ToolHookEvent[] = [
      completedEvent({ tool: "bash" }),
      completedEvent({ agent: "build" }),
      completedEvent({ agent: "reviewer" }),
      completedEvent({ input: { path: "src/large.ts", offset: 0 } }),
      completedEvent({ input: { path: "src/large.ts", limit: 0 } }),
      completedEvent({ content: "small" }),
      failedEvent(),
    ]

    for (const event of events) await harness.run(event)
    expect(harness.sessionCalls()).toBe(0)
  })

  test("fails open for worker errors, empty responses, and timeouts", async () => {
    const cases = [
      async () => {
        throw new Error("provider failed")
      },
      async () => ({ text: "  " }),
      () => new Promise<{ text: string }>(() => undefined),
    ]

    for (const [index, generate] of cases.entries()) {
      const harness = await setupHarness({
        generate,
        plugin: { generationTimeoutMs: index === 2 ? 5 : 30_000 },
      })
      const target = completedEvent({ sessionID: `ses_failure_${index}` })
      const original = target.result.content
      await harness.run(target)
      expect(target.result.content).toBe(original)
    }
  })

  test("keeps replacement when statistics fail", async () => {
    const harness = await setupHarness({
      plugin: { statsFile: "/proc/read-shunt/stats.jsonl" },
      storageSet: async () => {
        throw new Error("storage failed")
      },
    })
    const target = completedEvent()

    await harness.run(target)

    expect(visibleText(target)).toContain("value, line 1")
    expect(visibleText(target)).toContain("main-context tokens avoided")
  })
})
