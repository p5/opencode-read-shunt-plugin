export type ShellRead = {
  command: "cat" | "head" | "tail" | "less" | "more"
  path: string
  scope: "full" | "partial"
}

const partialCommands = new Set<ShellRead["command"]>(["head", "tail"])
const supportedCommands: ReadonlySet<string> = new Set(["cat", "head", "tail", "less", "more"])
const countOptions = new Set(["-n", "--lines", "-c", "--bytes"])

export function parseBroadShellRead(command: string): ShellRead | undefined {
  if (/[|&;><\n\r`$*?{}[\]~]/.test(command)) return
  const tokens = tokenize(command)
  if (!tokens) return
  if (tokens[0] === "command") tokens.shift()

  const commandName = tokens.shift()
  if (!isSupportedCommand(commandName)) return
  const targets = targetArguments(commandName, tokens)
  if (targets.length !== 1) return
  const path = targets[0]
  if (path === undefined) return

  return {
    command: commandName,
    path: path.slice(0, 500),
    scope: partialCommands.has(commandName) ? "partial" : "full",
  }
}

function targetArguments(command: ShellRead["command"], arguments_: readonly string[]): string[] {
  const targets: string[] = []
  let optionsEnded = false
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!
    if (!optionsEnded && argument === "--") {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && partialCommands.has(command) && countOptions.has(argument)) {
      index++
      if (index >= arguments_.length) return []
      continue
    }
    if (!optionsEnded && isOption(command, argument)) continue
    targets.push(argument)
  }
  return targets
}

function isOption(command: ShellRead["command"], argument: string): boolean {
  if (argument !== "-" && argument.startsWith("-")) return true
  return partialCommands.has(command) && /^[+]\d/.test(argument)
}

function tokenize(command: string): string[] | undefined {
  const tokens: string[] = []
  let token = ""
  let quote: "'" | '"' | undefined
  let escaped = false

  const push = () => {
    if (!token) return
    tokens.push(token)
    token = ""
  }

  for (const character of command.trim()) {
    if (escaped) {
      token += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      else token += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (/\s/.test(character)) push()
    else token += character
  }
  if (quote || escaped) return
  push()
  return tokens
}

function isSupportedCommand(value: string | undefined): value is ShellRead["command"] {
  return value !== undefined && supportedCommands.has(value)
}
