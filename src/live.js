// Live extraction for uncached (26.x+ unobfuscated) releases: range-read the
// client jar, interpret the biome bytecode for params, read the registration
// order and colormap textures, build the same doc shape as the backfill.
// Validation gates every result; nothing unvalidated is ever returned upward.
import { openRemoteZip } from "./lib/rangezip.js"
import { findBiomeOrderInJar, buildBiomeRecord } from "./lib/biome.js"
import { extractBiomeParams, recordsToParams } from "./lib/biomeparams.js"
import { decodePng } from "./lib/colormap.js"
import { sha256hex } from "./lib/inflate.js"
import { validateDoc } from "./lib/validate.js"

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
const FLOOR = "1.16.2" // oldest supported version (biome-data era floor)
const TEX = "assets/minecraft/textures/colormap"

export const EXTRACTOR_V = 1

export class UnsupportedVersion extends Error {}

export async function extractColormap(env, version) {
  const manifest = await (await fetch(MANIFEST)).json()
  const entry = manifest.versions.find((v) => v.id === version)
  if (!entry) throw new UnsupportedVersion(`unknown version ${version}`)
  if (entry.type !== "release") {
    // the latest snapshot is allowed; anything older is not
    if (version !== manifest.latest.snapshot) throw new UnsupportedVersion(`only the latest snapshot is supported`)
  } else {
    // manifest is newest-first, so anything after the floor entry is older than it
    const releases = manifest.versions.filter((v) => v.type === "release")
    if (releases.findIndex((v) => v.id === version) > releases.findIndex((v) => v.id === FLOOR)) {
      throw new UnsupportedVersion(`versions older than ${FLOOR} are not supported`)
    }
  }

  const pkg = await (await fetch(entry.url)).json()
  const zip = await openRemoteZip(pkg.downloads.client.url)

  // params via bytecode interpretation (throws on obfuscated/pre-26.x jars)
  const params = recordsToParams(await extractBiomeParams(zip))
  const names = new Set(Object.keys(params))

  const found = await findBiomeOrderInJar(zip, names)
  if (!found || found.order.length !== names.size) {
    throw new Error(`biome order mismatch: ${found ? found.order.length : 0} vs ${names.size}`)
  }

  const grassBuf = await zip.read(`${TEX}/grass.png`)
  const foliageBuf = await zip.read(`${TEX}/foliage.png`)
  if (!grassBuf || !foliageBuf) throw new Error("no colormap textures in jar")
  const dryBuf = await zip.read(`${TEX}/dry_foliage.png`)
  const maps = {
    grass: await decodePng(grassBuf),
    foliage: await decodePng(foliageBuf),
    dry: dryBuf ? await decodePng(dryBuf) : null,
  }

  const biomes = found.order.map((name, id) => buildBiomeRecord(name, id, params[name], maps))

  const dim = await zip.read("data/minecraft/dimension_type/overworld.json")
  if (!dim) throw new Error("no overworld dimension type in jar")
  const { min_y, height } = JSON.parse(new TextDecoder().decode(dim))

  const textures = { grass: await sha256hex(grassBuf), foliage: await sha256hex(foliageBuf) }
  if (dryBuf) textures.dryFoliage = await sha256hex(dryBuf)

  const doc = { worldMinY: min_y, worldMaxY: min_y + height, textures, biomes }
  validateDoc(doc)

  // make the referenced textures fetchable before the doc is ever served
  if (env?.TEXTURES) {
    const bufs = { [textures.grass]: grassBuf, [textures.foliage]: foliageBuf }
    if (dryBuf) bufs[textures.dryFoliage] = dryBuf
    for (const [hash, buf] of Object.entries(bufs)) {
      const key = `${hash}.png`
      if (!(await env.TEXTURES.head(key))) await env.TEXTURES.put(key, buf, { httpMetadata: { contentType: "image/png" } })
    }
  }

  return doc
}
