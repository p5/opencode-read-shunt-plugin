import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { SavingsEntry, SavingsStore } from "../contracts.js"
import type { SessionSavings } from "../core.js"

export class FileSavingsStore implements SavingsStore {
  constructor(
    private readonly stateDirectory: string,
    private readonly statsFile: string,
  ) {}

  async load(sessionID: string): Promise<SessionSavings> {
    try {
      const value = JSON.parse(await readFile(this.sessionPath(sessionID), "utf8")) as Partial<SessionSavings>
      if (typeof value.shunts === "number" && typeof value.savedChars === "number") {
        return { shunts: value.shunts, savedChars: value.savedChars }
      }
    } catch {}
    return { shunts: 0, savedChars: 0 }
  }

  async save(sessionID: string, savings: SessionSavings): Promise<void> {
    await mkdir(join(this.stateDirectory, "sessions"), { recursive: true, mode: 0o700 })
    await writeFile(this.sessionPath(sessionID), JSON.stringify(savings), { mode: 0o600 })
  }

  async record(entry: SavingsEntry): Promise<void> {
    await mkdir(dirname(this.statsFile), { recursive: true, mode: 0o700 })
    await appendFile(this.statsFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }

  private sessionPath(sessionID: string): string {
    return join(this.stateDirectory, "sessions", `${safeName(sessionID)}.json`)
  }
}

function safeName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_")
}
