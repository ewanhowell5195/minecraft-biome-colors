// Usage: node scripts/backfill/export-all.js [version ...]   (default: all releases >= 1.16.2)
import { writeFileSync, mkdirSync } from "node:fs"
import { openZip } from "../../src/lib/zip.js"
import { decodePng } from "../../src/lib/colormap.js"
import { sha256hex } from "../../src/lib/inflate.js"
import { findBiomeOrderInJar, buildBiomeRecord } from "../../src/lib/biome.js"

const OUT = "backfill/data"
const FLOOR = "1.16.2"
const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
const MCMETA = (v, branch, path) => `https://raw.githubusercontent.com/misode/mcmeta/${v}-${branch}/${path}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    let r
    try { r = await fetch(url) } catch { await sleep(400 * (i + 1)); continue }
    if (r.ok) return r.json()
    if (r.status === 404) return null
    await sleep(500 * (i + 1))
  }
  throw new Error("fetch failed " + url)
}
async function fetchBuf(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return Buffer.from(await r.arrayBuffer()) } catch {}
    await sleep(500 * (i + 1))
  }
  throw new Error("download failed " + url)
}
async function mapLimit(items, limit, fn) {
  let i = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx) }
  }))
}

async function worldHeight(v) {
  const j = await fetchJson(MCMETA(v, "data-json", "data/minecraft/dimension_type/overworld.json"))
  if (j && typeof j.min_y === "number" && typeof j.height === "number") return { min: j.min_y, max: j.min_y + j.height }
  return { min: 0, max: 256 } // pre-1.18 default
}

function validate(doc) {
  const by = Object.fromEntries(doc.biomes.map((b) => [b.id, b]))
  const plains = by["plains"]
  if (!plains) throw new Error("no plains")
  if (plains.temperature !== 0.8 || plains.downfall !== 0.4) throw new Error(`plains off: ${plains.temperature}/${plains.downfall}`)
  if (!/^#[0-9a-f]{6}$/.test(plains.grassColor)) throw new Error("plains grassColor malformed")
  const ids = doc.biomes.map((b) => b.numericId)
  if (new Set(ids).size !== ids.length) throw new Error("duplicate numericId")
  if (Math.min(...ids) !== 0 || Math.max(...ids) !== ids.length - 1) throw new Error("numericId not contiguous")
}

async function exportVersion(v) {
  const pkg = await fetchJson(v.url)
  const reg = await fetchJson(MCMETA(v.id, "summary", "registries/data.min.json"))
  if (!reg || !reg["worldgen/biome"]) throw new Error("no mcmeta registry")
  const names = reg["worldgen/biome"]
  const set = new Set(names)

  const params = {}
  await mapLimit(names, 6, async (name) => {
    const j = await fetchJson(MCMETA(v.id, "data-json", `data/minecraft/worldgen/biome/${name}.json`))
    if (j) params[name] = j
  })

  const jar = openZip(await fetchBuf(pkg.downloads.client.url))
  const grassBuf = await jar.read("assets/minecraft/textures/colormap/grass.png")
  const foliageBuf = await jar.read("assets/minecraft/textures/colormap/foliage.png")
  if (!grassBuf || !foliageBuf) throw new Error("no colormap textures in jar")
  const dryBuf = await jar.read("assets/minecraft/textures/colormap/dry_foliage.png") // added 1.21.5
  const maps = {
    grass: await decodePng(grassBuf),
    foliage: await decodePng(foliageBuf),
    dry: dryBuf ? await decodePng(dryBuf) : null,
  }

  const found = await findBiomeOrderInJar(jar, set)
  if (!found || found.order.length < set.size) throw new Error(`biome order ${found ? found.order.length : 0}/${set.size}`)

  const biomes = found.order.map((name, id) => {
    if (!params[name]) throw new Error("missing params for " + name)
    return buildBiomeRecord(name, id, params[name], maps)
  })

  const { min, max } = await worldHeight(v.id)
  const textures = { grass: await sha256hex(grassBuf), foliage: await sha256hex(foliageBuf) }
  if (dryBuf) textures.dryFoliage = await sha256hex(dryBuf)
  const doc = { worldMinY: min, worldMaxY: max, textures, biomes }
  validate(doc)
  mkdirSync(OUT, { recursive: true })
  writeFileSync(`${OUT}/${v.id}.json`, JSON.stringify(doc, null, 2) + "\n")
  return { version: v.id, biomes: biomes.length, cls: found.cls }
}

async function main() {
  const manifest = await fetchJson(MANIFEST)
  const releases = manifest.versions.filter((v) => v.type === "release")
  const floorIdx = releases.findIndex((v) => v.id === FLOOR)
  let targets = releases.slice(0, floorIdx + 1)
  const only = process.argv.slice(2)
  if (only.length) targets = targets.filter((v) => only.includes(v.id))

  console.log(`exporting ${targets.length} versions (${targets[0].id} .. ${targets[targets.length - 1].id})`)
  const ok = [], failed = []
  for (const v of targets) {
    const t0 = Date.now()
    try {
      const r = await exportVersion(v)
      ok.push(r)
      console.log(`  OK  ${v.id.padEnd(9)} ${String(r.biomes).padStart(3)} biomes  ${((Date.now() - t0) / 1000).toFixed(1)}s  [${r.cls}]`)
    } catch (e) {
      failed.push({ version: v.id, error: e.message })
      console.log(`  FAIL ${v.id.padEnd(9)} ${e.message}`)
    }
  }
  console.log(`\ndone: ${ok.length} ok, ${failed.length} failed`)
  if (failed.length) console.log("failed:", failed.map((f) => `${f.version} (${f.error})`).join("; "))
}
main().catch((e) => { console.error(e); process.exit(1) })
