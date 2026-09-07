export type ShellRead = {
  command: "cat" | "less" | "more"
  path: string
}

export function parseBroadShellRead(command: string): ShellRead | undefined {
  const trimmed = command.trim()
  if (!trimmed || /[|>&;\n]/.test(trimmed)) return

  const match = /^(?:command\s+)?(cat|less|more)(?:\s|$)/.exec(trimmed)
  if (!match) return

  const commandName = match[1] as ShellRead["command"]
  const argumentsOnly = trimmed.slice(match[0].length)
  const targets = argumentsOnly
    .split(/\s+/)
    .filter(Boolean)
    .filter((argument) => !argument.startsWith("-"))
  if (targets.length !== 1) return

  return {
    command: commandName,
    path: targets[0]!.replaceAll(/["']/g, "").slice(0, 500),
  }
}
