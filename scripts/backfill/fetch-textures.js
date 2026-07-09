import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { sha256hex } from "../../src/lib/inflate.js"

const DATA = "backfill/data"
const OUT = "backfill/textures"
const ASSET_FILE = { grass: "grass", foliage: "foliage", dryFoliage: "dry_foliage" }
const ASSET = (v, type) =>
  `https://raw.githubusercontent.com/misode/mcmeta/${v}-assets/assets/minecraft/textures/colormap/${ASSET_FILE[type]}.png`

const files = readdirSync(DATA).filter((f) => f.endsWith(".json") && !f.startsWith("_"))
const uniq = new Map() // hash -> { type, version }
for (const f of files) {
  const d = JSON.parse(readFileSync(`${DATA}/${f}`))
  const v = f.replace(".json", "")
  for (const type of ["grass", "foliage", "dryFoliage"]) {
    const h = d.textures[type]
    if (h && !uniq.has(h)) uniq.set(h, { type, version: v })
  }
}

mkdirSync(OUT, { recursive: true })
const bad = []
for (const [hash, { type, version }] of uniq) {
  const r = await fetch(ASSET(version, type))
  if (!r.ok) { bad.push({ hash, reason: `fetch ${r.status}` }); continue }
  const buf = Buffer.from(await r.arrayBuffer())
  const got = await sha256hex(buf)
  if (got !== hash) { bad.push({ hash, reason: `hash mismatch (got ${got.slice(0, 12)})`, version, type }); continue }
  writeFileSync(`${OUT}/${hash}.png`, buf)
  console.log(`saved ${type.padEnd(10)} ${hash.slice(0, 12)}…  ${buf.length} bytes  (via ${version})`)
}
console.log(`\n${uniq.size - bad.length}/${uniq.size} textures saved to ${OUT}/`)
if (bad.length) console.log("MISMATCH/FAIL:", JSON.stringify(bad, null, 2))
