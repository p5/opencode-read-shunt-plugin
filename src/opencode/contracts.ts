import type { Plugin } from "@opencode-ai/plugin"

type ToolHookEvent = Parameters<Parameters<Plugin.Context["tool"]["hook"]>[1]>[0]
type HostCompletedEvent = Extract<ToolHookEvent, { status: "completed" }>
type HostBeforeEvent = Exclude<ToolHookEvent, { status: string }>
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

export type CompletedToolEvent = Mutable<
  Pick<HostCompletedEvent, "tool" | "status" | "input">
> & {
  sessionID: string
  agent: string
  result: Mutable<HostCompletedEvent["result"]>
}

export type BeforeToolEvent = Pick<HostBeforeEvent, "tool" | "input"> & {
  sessionID: string
  agent: string
}
