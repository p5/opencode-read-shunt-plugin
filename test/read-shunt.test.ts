import { describe, expect, test } from "bun:test"
import type { SavingsEntry, SavingsLog, SessionSavingsStore, SummaryWorker } from "../src/contracts"
import type { SessionSavings } from "../src/core"
import { resolvePolicyConfig } from "../src/core"
import { ReadShunt } from "../src/read-shunt"

class MemorySavings implements SessionSavingsStore, SavingsLog {
  session: SessionSavings = { shunts: 0, savedChars: 0 }
  entries: SavingsEntry[] = []

  async update<T>(
    _sessionID: string,
    operation: (current: SessionSavings) => { savings: SessionSavings; value: T },
  ): Promise<T> {
    await Promise.resolve()
    const result = operation(this.session)
    this.session = result.savings
    return result.value
  }

  async append(entry: SavingsEntry): Promise<void> {
    this.entries.push(entry)
  }
}

const worker: SummaryWorker = {
  model: "test/summary",
  summarize: async () => ({ text: "Useful summary." }),
}

describe("ReadShunt", () => {
  test("serializes savings updates for one session", async () => {
    const savings = new MemorySavings()
    const shunt = new ReadShunt({
      host: "codex",
      policy: resolvePolicyConfig({ thresholdChars: 1 }),
      sessions: savings,
      log: savings,
    })
    const request = {
      sessionID: "session",
      task: "Review code.",
      candidate: { path: "large.ts", content: "x".repeat(1_000), lines: 1, truncated: false },
    }

    const results = await Promise.all([shunt.run(request, worker), shunt.run(request, worker)])

    expect(results.map((result) => result?.entry.sessionShunts).sort()).toEqual([1, 2])
    expect(savings.session.shunts).toBe(2)
    expect(savings.entries).toHaveLength(2)
  })

})
