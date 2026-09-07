import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { SavingsEntry, SavingsLog, SessionSavingsStore } from "../contracts.js"
import { isRecord, type SessionSavings } from "../core.js"

export class FileSessionSavingsStore implements SessionSavingsStore {
  constructor(private readonly stateDirectory: string) {}

  async update<T>(
    sessionID: string,
    operation: (current: SessionSavings) => { savings: SessionSavings; value: T },
  ): Promise<T> {
    const directory = join(this.stateDirectory, "sessions")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `${safeName(sessionID)}.json`)
    const result = operation(await readSavings(path))
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(result.savings), { mode: 0o600 })
      await rename(temporary, path)
      return result.value
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
}

export class JsonlSavingsLog implements SavingsLog {
  constructor(private readonly path: string) {}

  async append(entry: SavingsEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }
}

async function readSavings(path: string): Promise<SessionSavings> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    if (isRecord(value) && isCount(value.shunts) && isCount(value.savedChars)) {
      return { shunts: value.shunts, savedChars: value.savedChars }
    }
    throw new Error(`invalid session statistics in ${path}`)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { shunts: 0, savedChars: 0 }
    throw error
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function safeName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_")
}
