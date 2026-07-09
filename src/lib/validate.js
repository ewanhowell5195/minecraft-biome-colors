// Guardrails before anything enters the permanent cache: known anchors and
// structural sanity. Throws with a reason on failure.
export function validateDoc(doc) {
  const biomes = doc.biomes
  if (!Array.isArray(biomes) || biomes.length < 40 || biomes.length > 200) throw new Error(`implausible biome count ${biomes?.length}`)

  const by = Object.fromEntries(biomes.map((b) => [b.id, b]))
  const plains = by["plains"]
  if (!plains) throw new Error("no plains")
  if (plains.temperature !== 0.8 || plains.downfall !== 0.4) throw new Error(`plains temp/downfall off: ${plains.temperature}/${plains.downfall}`)
  if (!by["desert"] || by["desert"].downfall !== 0) throw new Error("desert downfall not 0")
  if (!by["swamp"] || by["swamp"].grassColorModifier !== "swamp") throw new Error("swamp missing grass modifier")

  for (const b of biomes) {
    for (const k of ["grassColor", "foliageColor", "waterColor", "skyColor"]) {
      if (!/^#[0-9a-f]{6}$/.test(b[k])) throw new Error(`${b.id}.${k} malformed: ${b[k]}`)
    }
  }
  const ids = biomes.map((b) => b.numericId)
  if (new Set(ids).size !== ids.length) throw new Error("duplicate numericId")
  if (Math.min(...ids) !== 0 || Math.max(...ids) !== ids.length - 1) throw new Error("numericId not contiguous")

  if (typeof doc.worldMinY !== "number" || typeof doc.worldMaxY !== "number" || doc.worldMaxY <= doc.worldMinY) throw new Error("bad world height")
  for (const k of ["grass", "foliage"]) {
    if (!/^[0-9a-f]{64}$/.test(doc.textures[k] ?? "")) throw new Error(`missing ${k} texture hash`)
  }
}
