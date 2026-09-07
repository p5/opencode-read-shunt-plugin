import { CodexAdapter } from "./adapter.js"
import { parseCodexHookInput } from "./candidate.js"
import { loadCodexConfig } from "./config.js"

async function main(): Promise<void> {
  try {
    const input = parseCodexHookInput(await Bun.stdin.json())
    if (!input) return
    const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd()
    const output = await new CodexAdapter(await loadCodexConfig(cwd)).handle(input)
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`)
  } catch (error) {
    console.error(`read-shunt failed open: ${error instanceof Error ? error.message : String(error)}`)
  }
}

await main()
