// Prints the wrangler upload commands; pass --run to execute them.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"

const DATA = "backfill/data"
const TEX = "backfill/textures"
const BUCKET = "colormap-textures"
const KV_BULK = "backfill/_kv-bulk.json"
const run = process.argv.includes("--run")

const bulk = readdirSync(DATA)
  .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
  .map((f) => ({ key: f.replace(".json", ""), value: readFileSync(`${DATA}/${f}`, "utf8") }))
writeFileSync(KV_BULK, JSON.stringify(bulk))
console.log(`wrote ${KV_BULK} (${bulk.length} versions)`)

const textures = readdirSync(TEX).filter((f) => f.endsWith(".png"))
const kvCmd = `wrangler kv bulk put ${KV_BULK} --binding COLORMAPS --remote`
const texCmds = textures.map((f) => `wrangler r2 object put ${BUCKET}/${f} --file ${TEX}/${f} --content-type image/png --remote`)

if (!run) {
  console.log("\n# Run these (or re-run with --run):\n")
  console.log(kvCmd)
  texCmds.forEach((c) => console.log(c))
  console.log(`\n${textures.length} textures, 1 KV bulk put`)
} else {
  console.log("\nuploading KV…")
  execSync("npx " + kvCmd, { stdio: "inherit" })
  console.log(`uploading ${textures.length} textures…`)
  for (const c of texCmds) execSync("npx " + c, { stdio: "inherit" })
  console.log("done")
}
