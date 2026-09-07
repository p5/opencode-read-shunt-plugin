import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { PiAdapter } from "./adapter.js"
import { loadPiConfig, type PiConfig } from "./config.js"

export type PiConfigLoader = (cwd: string) => Promise<PiConfig>

export function registerPiExtension(
  pi: ExtensionAPI,
  configLoader: PiConfigLoader = loadPiConfig,
): void {
  let cwd: string | undefined
  let adapter: PiAdapter | undefined

  const adapterFor = async (context: ExtensionContext): Promise<PiAdapter> => {
    if (!adapter || cwd !== context.cwd) {
      cwd = context.cwd
      adapter = new PiAdapter(await configLoader(context.cwd))
    }
    return adapter
  }

  pi.on("session_start", async (_event, context) => {
    await adapterFor(context)
  })
  pi.on("tool_result", async (event, context) => {
    try {
      return await (await adapterFor(context)).handle({ event, context })
    } catch (error) {
      console.warn(`read-shunt failed open: ${errorMessage(error)}`)
    }
  })
}

export default registerPiExtension

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
