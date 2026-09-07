import type { Plugin } from "@opencode-ai/plugin"
import type { SessionSavingsStore } from "../contracts.js"
import type { SessionSavings } from "../core.js"

export class OpenCodeSessionSavingsStore implements SessionSavingsStore {
  constructor(private readonly storage: Plugin.Context["storage"]) {}

  async update<T>(
    sessionID: string,
    operation: (current: SessionSavings) => { savings: SessionSavings; value: T },
  ): Promise<T> {
    const value = await this.storage.get(sessionKey(sessionID))
    const result = operation(isSavings(value) ? value : { shunts: 0, savedChars: 0 })
    await this.storage.set(sessionKey(sessionID), result.savings)
    return result.value
  }
}

function isSavings(value: unknown): value is SessionSavings {
  return (
    typeof value === "object" &&
    value !== null &&
    "shunts" in value &&
    "savedChars" in value &&
    isCount(value.shunts) &&
    isCount(value.savedChars)
  )
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function sessionKey(sessionID: string): string {
  return `read-shunt/session/${sessionID}`
}
