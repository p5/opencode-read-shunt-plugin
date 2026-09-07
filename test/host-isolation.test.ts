import { describe, expect, test } from "bun:test"

describe("host isolation", () => {
  test("keeps Codex imports out of the OpenCode entry point", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text()
    expect(source).not.toContain("./codex/")
    expect(source).toContain("./opencode/adapter.js")
  })

  test("keeps host imports inside each adapter", async () => {
    const packages = {
      codex: [] as string[],
      opencode: ["@opencode-ai/plugin"],
      pi: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
    }
    for (const host of Object.keys(packages) as (keyof typeof packages)[]) {
      for await (const path of new Bun.Glob("*.ts").scan({ cwd: new URL(`../src/${host}`, import.meta.url).pathname })) {
        const source = await Bun.file(new URL(`../src/${host}/${path}`, import.meta.url)).text()
        for (const otherHost of Object.keys(packages) as (keyof typeof packages)[]) {
          if (otherHost === host) continue
          expect(source, `${host}/${path}`).not.toContain(`../${otherHost}/`)
          for (const packageName of packages[otherHost]) {
            expect(source, `${host}/${path}`).not.toContain(packageName)
          }
        }
      }
    }
  })

  test("keeps host adapters out of shared modules", async () => {
    const root = new URL("../src", import.meta.url).pathname
    for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
      if (path === "index.ts" || /^(?:codex|opencode|pi)\//.test(path)) continue
      const source = await Bun.file(new URL(`../src/${path}`, import.meta.url)).text()
      expect(source, path).not.toMatch(/from ["'].+(?:codex|opencode|pi)\//)
      expect(source, path).not.toContain("@opencode-ai/plugin")
      expect(source, path).not.toContain("@earendil-works/pi-")
    }
  })
})
