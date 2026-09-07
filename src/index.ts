import { Plugin } from "@opencode-ai/plugin"
import { OpenCodeAdapter } from "./opencode/adapter.js"

const plugin = Plugin.define({
  id: "ReadShunt",
  setup: async (context) => new OpenCodeAdapter(context).install(),
})

export default plugin
