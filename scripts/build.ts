import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const outputDirectory = join(root, "dist")
await rm(outputDirectory, { recursive: true, force: true })

const build = await Bun.build({
  entrypoints: [join(root, "src/index.ts"), join(root, "src/codex/main.ts"), join(root, "extensions/read-shunt.ts")],
  outdir: outputDirectory,
  target: "bun",
  format: "esm",
  external: ["@opencode-ai/plugin", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
})
if (!build.success) throw new AggregateError(build.logs, "Build failed.")

const artifacts = [
  { path: "src/index.js", forbidden: ["@earendil-works", "CodexCliSummaryWorker"] },
  { path: "src/codex/main.js", forbidden: ["@opencode-ai", "@earendil-works"] },
  { path: "extensions/read-shunt.js", forbidden: ["@opencode-ai", "CodexCliSummaryWorker"] },
]
for (const artifact of artifacts) {
  const source = await readFile(join(outputDirectory, artifact.path), "utf8")
  for (const marker of artifact.forbidden) {
    if (source.includes(marker)) throw new Error(`${artifact.path} contains forbidden marker: ${marker}`)
  }
}
