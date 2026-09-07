import { describe, expect, test } from "bun:test"
import {
  applyReplacement,
  bashReadPath,
  createReplacement,
  readCandidate,
  resolveConfig,
  withTimeout,
  type CompletedToolEvent,
} from "../src/core"

const content = "export function value() { return 42 }\n".repeat(500)

function event(input: Record<string, unknown> = { path: "src/large.ts" }): CompletedToolEvent {
  return {
    tool: "read",
    sessionID: "ses_test",
    agent: "explore",
    status: "completed",
    input,
    result: {
      output: { type: "file", encoding: "utf8", truncated: false },
      content: [{ type: "text", text: content }],
      metadata: {},
    },
  }
}

describe("core", () => {
  test("replaces a large read with a smaller complete payload", () => {
    const target = event()
    const candidate = readCandidate(target, resolveConfig({ thresholdChars: 100 }))
    expect(candidate).toBeDefined()
    const replacement = createReplacement(content.length, "Summary at line 1", 4_000, { shunts: 2, savedChars: 8_000 })
    expect(replacement).toBeDefined()
    applyReplacement(target, candidate!, replacement!)

    const visible = (target.result.content as Array<{ text: string }>)[0]!.text
    expect(visible.length).toBe(replacement!.replacementChars)
    expect(replacement!.savedChars).toBe(content.length - visible.length)
    expect(visible).toContain("session: 3 shunts")
  })

  test("matches the Spotify read routing matrix", () => {
    const config = resolveConfig({ thresholdChars: 100 })
    const cases: Array<{ name: string; target: CompletedToolEvent; shunt: boolean }> = [
      { name: "large full read", target: event(), shunt: true },
      { name: "offset", target: event({ path: "src/large.ts", offset: 100 }), shunt: false },
      { name: "offset zero", target: event({ path: "src/large.ts", offset: 0 }), shunt: false },
      { name: "limit", target: event({ path: "src/large.ts", limit: 50 }), shunt: false },
      { name: "limit zero", target: event({ path: "src/large.ts", limit: 0 }), shunt: false },
      { name: "offset and limit", target: event({ path: "src/large.ts", offset: 100, limit: 50 }), shunt: false },
      { name: "missing path", target: event({}), shunt: false },
      { name: "empty path", target: event({ path: "" }), shunt: false },
    ]
    for (const item of cases) {
      expect(readCandidate(item.target, config) !== undefined, item.name).toBe(item.shunt)
    }
  })

  test("matches the Spotify Bash routing matrix", () => {
    const config = resolveConfig({ allowedAgents: ["explore"] })
    const path = "/tmp/large.txt"
    const cases = [
      ["cat /tmp/large.txt", path],
      ["cat -n /tmp/large.txt", path],
      ["head /tmp/large.txt", path],
      ["head -100 /tmp/large.txt", path],
      ["head -n 5 /tmp/large.txt", "5"],
      ["tail /tmp/large.txt", path],
      ["less /tmp/large.txt", path],
      ["more /tmp/large.txt", path],
      ['cat "/tmp/large.txt"', path],
      ["cat /tmp/large.txt | grep export", undefined],
      ["cat /tmp/large.txt > /tmp/out.txt", undefined],
      ["git status", undefined],
      ["grep export /tmp/large.txt", undefined],
      ["", undefined],
    ] as const

    for (const [command, expected] of cases) {
      expect(
        bashReadPath({ tool: "bash", sessionID: "ses_test", agent: "explore", input: { command } }, config),
        command,
      ).toBe(expected)
    }
    expect(
      bashReadPath({ tool: "bash", sessionID: "ses_test", agent: "build", input: { command: `cat ${path}` } }, config),
    ).toBeUndefined()
    expect(bashReadPath({ tool: "bash", sessionID: "ses_test", agent: "explore", input: {} }, config)).toBeUndefined()
    expect(
      bashReadPath({ tool: "read", sessionID: "ses_test", agent: "explore", input: { command: `cat ${path}` } }, config),
    ).toBeUndefined()
  })

  test("allows exact threshold and shunts above it", () => {
    const atThreshold = "line\n".repeat(349) + "line"
    const aboveThreshold = `${atThreshold}\nline`
    const config = resolveConfig({ thresholdChars: 1_000_000, thresholdLines: 350 })
    const target = event()
    target.result.content = [{ type: "text", text: atThreshold }]
    expect(readCandidate(target, config)).toBeUndefined()
    target.result.content = [{ type: "text", text: aboveThreshold }]
    expect(readCandidate(target, config)).toBeDefined()
  })

  test("uses configured thresholds and safe defaults", () => {
    const text = "line\n".repeat(250)
    const target = event()
    target.result.content = text
    expect(readCandidate(target, resolveConfig({ thresholdChars: 1_000_000, thresholdLines: 200 }))).toBeDefined()
    expect(readCandidate(target, resolveConfig({ thresholdChars: 1_000_000, thresholdLines: 500 }))).toBeUndefined()
    expect(
      readCandidate(target, resolveConfig({ thresholdChars: 1_000_000, thresholdLines: "invalid" })),
    ).toBeUndefined()
  })

  test("bypasses protected results and agents", () => {
    const config = resolveConfig({ thresholdChars: 100 })
    const build = event()
    build.agent = "build"
    const reviewer = event()
    reviewer.agent = "reviewer"
    const base64 = event()
    base64.result.output = { type: "file", encoding: "base64" }
    const unsupported = event()
    unsupported.result.output = { type: "directory", encoding: "utf8" }
    const multipleParts = event()
    multipleParts.result.content = [
      { type: "text", text: content },
      { type: "text", text: content },
    ]

    for (const target of [build, reviewer, base64, unsupported, multipleParts, event({ path: "AGENTS.md" })]) {
      expect(readCandidate(target, config)).toBeUndefined()
    }
  })

  test("keeps original content when replacement is larger", () => {
    expect(createReplacement(10, "larger summary", 4_000, { shunts: 0, savedChars: 0 })).toBeUndefined()
  })

  test("keeps original content when worker response is empty", () => {
    expect(createReplacement(content.length, "  \n", 4_000, { shunts: 0, savedChars: 0 })).toBeUndefined()
  })

  test("times out stalled generation", async () => {
    await expect(withTimeout(new Promise(() => undefined), 5)).rejects.toThrow("generation timed out after 5 ms")
  })
})
