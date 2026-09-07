import { describe, expect, test } from "bun:test"
import { parseBroadShellRead } from "../src/shell-read"

describe("shell read parser", () => {
  test("parses one static target and reports its scope", () => {
    const cases = [
      ["cat file.ts", { command: "cat", path: "file.ts", scope: "full" }],
      ["cat -n 'path with spaces.ts'", { command: "cat", path: "path with spaces.ts", scope: "full" }],
      ["command less -- file.ts", { command: "less", path: "file.ts", scope: "full" }],
      ["head -n 5 file.ts", { command: "head", path: "file.ts", scope: "partial" }],
      ["tail --lines=10 file.ts", { command: "tail", path: "file.ts", scope: "partial" }],
      ["head -20 file.ts", { command: "head", path: "file.ts", scope: "partial" }],
      ["tail +20 file.ts", { command: "tail", path: "file.ts", scope: "partial" }],
    ] as const

    for (const [command, expected] of cases) expect(parseBroadShellRead(command), command).toEqual(expected)
  })

  test("rejects ambiguous or dynamic shell input", () => {
    const cases = [
      "cat one.ts two.ts",
      "cat - file.ts",
      "cat file.ts | rg value",
      "cat file.ts > copy.ts",
      "cat file.ts; git status",
      "cat $(find . -name x)",
      "cat $FILE",
      "cat *.ts",
      "cat file?.ts",
      "cat src/{a,b}.ts",
      "cat [ab].ts",
      "cat ~/file.ts",
      "cat `find . -name x`",
      "cat 'unfinished",
      "cat unfinished\\",
      "sed -n 1,20p file.ts",
      "",
    ]

    for (const command of cases) expect(parseBroadShellRead(command), command).toBeUndefined()
  })
})
