import { describe, expect, test } from "bun:test"

describe("host isolation", () => {
  test("keeps Codex imports out of the OpenCode entry point", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text()
    expect(source).not.toContain("./codex/")
    expect(source).toContain("./opencode/adapter.js")
  })

  test("keeps OpenCode imports out of all Codex modules", async () => {
    for await (const path of new Bun.Glob("*.ts").scan({ cwd: new URL("../src/codex", import.meta.url).pathname })) {
      const source = await Bun.file(new URL(`../src/codex/${path}`, import.meta.url)).text()
      expect(source, path).not.toContain("@opencode-ai/plugin")
      expect(source, path).not.toContain("../opencode/")
    }
  })

  test("keeps Codex imports out of all OpenCode modules", async () => {
    for await (const path of new Bun.Glob("*.ts").scan({ cwd: new URL("../src/opencode", import.meta.url).pathname })) {
      const source = await Bun.file(new URL(`../src/opencode/${path}`, import.meta.url)).text()
      expect(source, path).not.toContain("../codex/")
    }
  })

  test("keeps host adapters out of shared modules", async () => {
    for (const path of ["contracts.ts", "core.ts", "service.ts"]) {
      const source = await Bun.file(new URL(`../src/${path}`, import.meta.url)).text()
      expect(source, path).not.toMatch(/from ["'].+(?:codex|opencode)\//)
      expect(source, path).not.toContain("@opencode-ai/plugin")
    }
  })
})
