import { CodexAdapter, loadCodexConfig, type CodexHookInput } from "./adapter.js"

async function main(): Promise<void> {
  try {
    const input = (await Bun.stdin.json()) as CodexHookInput
    const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd()
    const output = await new CodexAdapter(await loadCodexConfig(cwd)).handle(input)
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`)
  } catch (error) {
    console.error(`read-shunt failed open: ${error instanceof Error ? error.message : String(error)}`)
  }
}

await main()
