import { parseClass, findCode, walkCode } from "./classparse.js"
import { toHex, hex, sample, applyGrassModifier } from "./colormap.js"

const DEFAULT_WATER = "#3f76e4"

// <clinit> string constant order = registration order = grid column order.
// Works on obfuscated jars: biome name strings are data, not obfuscated.
export function orderedBiomeStringsFromClinit(cls, biomeSet) {
  const clinit = findCode(cls, "<clinit>", "()V")
  if (!clinit) return []
  const dv = cls.dv
  const out = []
  const seen = new Set()
  walkCode(cls, clinit.codeStart, clinit.codeLen, (op, operandStart) => {
    let s
    if (op === 0x12) s = cls.strVal(dv.getUint8(operandStart)) // ldc
    else if (op === 0x13) s = cls.strVal(dv.getUint16(operandStart)) // ldc_w
    else return
    if (s !== undefined && biomeSet.has(s) && !seen.has(s)) { seen.add(s); out.push(s) }
  })
  return out
}

export async function findBiomeOrderInJar(zip, biomeSet) {
  const KNOWN = "net/minecraft/world/level/biome/Biomes.class"
  const known = await zip.read(KNOWN)
  if (known) {
    const order = orderedBiomeStringsFromClinit(parseClass(known), biomeSet)
    if (order.length >= biomeSet.size) return { order, cls: KNOWN }
  }
  const markers = ["sunflower_plains", "mushroom_fields", "frozen_ocean"].map((s) => textBytes(s))
  let best = null
  for (const [name, e] of zip.entries) {
    if (!name.endsWith(".class") || e.size < 2500) continue
    let bytes
    try { bytes = await zip.readEntry(e) } catch { continue }
    if (!markers.some((m) => indexOf(bytes, m) >= 0)) continue
    let order
    try { order = orderedBiomeStringsFromClinit(parseClass(bytes), biomeSet) } catch { continue }
    if (!best || order.length > best.order.length) best = { order, cls: name }
    if (best.order.length >= biomeSet.size) break
  }
  return best
}

// maps = { grass, foliage, dry } decoded colormaps (dry null pre-1.21.5)
export function buildBiomeRecord(name, id, j, maps) {
  const fx = j.effects || {}, attrs = j.attributes || {}
  const grassOverride = toHex(fx.grass_color)
  const foliageOverride = toHex(fx.foliage_color)
  const dryOverride = toHex(fx.dry_foliage_color)
  const grassMod = fx.grass_color_modifier ?? "none"
  const tempMod = j.temperature_modifier ?? "none"
  // pre-attributes data always has explicit sky_color; in the attributes era
  // (1.21.11+) an absent sky attribute means the registered default: black
  const skyRaw = attrs["minecraft:visual/sky_color"] ?? fx.sky_color
  const skyColor = skyRaw != null ? toHex(skyRaw) : "#000000"

  const grassColor = grassOverride ?? hex(applyGrassModifier(sample(maps.grass, j.temperature, j.downfall), grassMod))
  const foliageColor = foliageOverride ?? hex(sample(maps.foliage, j.temperature, j.downfall))
  const dryFoliageColor = dryOverride ?? (maps.dry ? hex(sample(maps.dry, j.temperature, j.downfall)) : null)

  const b = {
    id: name, numericId: id,
    temperature: j.temperature, downfall: j.downfall,
    grassColor, foliageColor,
    ...(dryFoliageColor ? { dryFoliageColor } : {}),
    waterColor: toHex(fx.water_color) ?? DEFAULT_WATER, skyColor,
  }
  if (tempMod !== "none") b.temperatureModifier = tempMod
  if (grassMod !== "none") b.grassColorModifier = grassMod
  if (grassOverride) b.grassColorOverride = grassOverride
  if (foliageOverride) b.foliageColorOverride = foliageOverride
  if (dryOverride) b.dryFoliageColorOverride = dryOverride
  // 'fixed' = does not sample the colormap triangle (override, or the swamp
  // grass modifier which returns a constant; dark_forest still samples).
  if (grassOverride || grassMod === "swamp") b.grassColorFixed = true
  if (foliageOverride) b.foliageColorFixed = true
  if (dryOverride) b.dryFoliageColorFixed = true
  return b
}

const textBytes = (s) => new TextEncoder().encode(s)
function indexOf(hay, needle) {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
