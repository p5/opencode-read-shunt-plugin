import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { PiAdapter } from "./adapter.js"
import { loadPiConfig, type PiConfig } from "./config.js"

export type PiConfigLoader = (cwd: string) => Promise<PiConfig>

export function registerPiExtension(
  pi: ExtensionAPI,
  configLoader: PiConfigLoader = loadPiConfig,
): void {
  const adapters = new Map<string, Promise<PiAdapter>>()

  const adapterFor = async (context: ExtensionContext): Promise<PiAdapter> => {
    let pending = adapters.get(context.cwd)
    if (!pending) {
      pending = configLoader(context.cwd).then((config) => new PiAdapter(config))
      adapters.set(context.cwd, pending)
    }
    try {
      return await pending
    } catch (error) {
      if (adapters.get(context.cwd) === pending) adapters.delete(context.cwd)
      throw error
    }
  }

  pi.on("session_start", async (_event, context) => {
    try {
      await adapterFor(context)
    } catch (error) {
      console.warn(`read-shunt failed open: ${errorMessage(error)}`)
      return undefined
    }
  })
  pi.on("tool_result", async (event, context) => {
    try {
      return await (await adapterFor(context)).handle({ event, context })
    } catch (error) {
      console.warn(`read-shunt failed open: ${errorMessage(error)}`)
      return undefined
    }
  })
}

export default registerPiExtension

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
