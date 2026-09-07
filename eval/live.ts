import { unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

const model = process.env.READ_SHUNT_EVAL_MODEL
if (!model) throw new Error("Set READ_SHUNT_EVAL_MODEL to run the live eval")

const root = join(import.meta.dir, "..")
const fixture = join(root, ".read-shunt-eval.ts")
const names = ["marker000", "marker199", "marker399"]
const source = Array.from({ length: 400 }, (_, index) => {
  const name = `marker${index.toString().padStart(3, "0")}`
  return `export const ${name} = ${index}`
}).join("\n")

await writeFile(fixture, `${source}\n`)
try {
  const child = Bun.spawn(
    [
      "opencode2",
      "run",
      "--standalone",
      "--auto",
      "--agent",
      "explore",
      "--model",
      model,
      "--format",
      "json",
      `Read the entire file ${fixture}. Report only these exact exported names: ${names.join(", ")}.`,
    ],
    { cwd: root, stdout: "pipe", stderr: "inherit" },
  )
  const output = await new Response(child.stdout).text()
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`opencode2 exited with status ${exitCode}`)

  const events = output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
  const serialized = JSON.stringify(events)
  if (!serialized.includes("[read-shunt:")) throw new Error("OpenCode result has no read-shunt marker")
  for (const name of names) {
    if (!serialized.includes(name)) throw new Error(`OpenCode result does not contain ${name}`)
  }
  console.log(`PASS live eval: shunted 400 lines and returned ${names.join(", ")}`)
} finally {
  await unlink(fixture).catch(() => undefined)
}
