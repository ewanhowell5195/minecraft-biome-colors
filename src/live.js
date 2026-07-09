// Live extraction for uncached (new 26.x+) versions; older ones are backfilled.
// The bytecode param extractor (temperature/downfall/effects from the Biome
// builder) is not built yet, so this throws rather than fabricating data.
import { openZip } from "./lib/zip.js"
import { findBiomeOrderInJar } from "./lib/biome.js"
import { decodePng } from "./lib/colormap.js"

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"

export class LiveNotImplemented extends Error {}

export async function extractColormap(env, version) {
  const manifest = await (await fetch(MANIFEST)).json()
  const entry = manifest.versions.find((v) => v.id === version)
  if (!entry) throw new Error(`unknown version ${version}`)

  void openZip; void findBiomeOrderInJar; void decodePng
  throw new LiveNotImplemented(`live extraction for ${version} not implemented`)
}
