// Extract biome params (temperature/downfall/effects) from unobfuscated 26.x+
// bytecode by abstractly interpreting BiomeData.bootstrap and the builder
// methods it calls. Builder objects are tracked as instances so competing
// builds (e.g. a branch's effects vs a helper's defaults) resolve the way Java
// does: whichever object is attached last wins. Emits params in the worldgen
// JSON shape so buildBiomeRecord consumes either source identically.
import { parseClass, findCode, parseDescriptor } from "./classparse.js"
import { defaultSky } from "./colormap.js"

const DATA_CLASSES = [
  "net/minecraft/data/worldgen/biome/BiomeData",
  "net/minecraft/data/worldgen/biome/OverworldBiomes",
  "net/minecraft/data/worldgen/biome/NetherBiomes",
  "net/minecraft/data/worldgen/biome/EndBiomes",
]
const BIOME_CLASS = "net/minecraft/world/level/biome/Biome"

// setter name -> param key (BiomeBuilder + BiomeSpecialEffects$Builder)
const SETTERS = {
  temperature: "temperature",
  downfall: "downfall",
  temperatureModifier: "temperature_modifier",
  temperatureAdjustment: "temperature_modifier",
  waterColor: "water_color",
  skyColor: "sky_color",
  grassColorOverride: "grass_color",
  foliageColorOverride: "foliage_color",
  dryFoliageColorOverride: "dry_foliage_color",
  grassColorModifier: "grass_color_modifier",
}
const ENUM_PARAMS = new Set(["temperature_modifier", "grass_color_modifier"])

const OPAQUE = Symbol("opaque")
const isNum = (v) => typeof v === "number"
const isObj = (v) => v !== null && typeof v === "object" && v.props !== undefined

export async function extractBiomeParams(zip) {
  const classes = new Map()
  for (const name of DATA_CLASSES) {
    const buf = await zip.read(`${name}.class`)
    if (!buf) throw new Error(`missing ${name}.class`)
    classes.set(name, parseClass(buf))
  }

  const biomes = {}
  const ctx = { classes, biomes }
  runMethod(ctx, "net/minecraft/data/worldgen/biome/BiomeData", "bootstrap", null, [OPAQUE])
  if (!Object.keys(biomes).length) throw new Error("bootstrap yielded no biomes")
  return biomes
}

function runMethod(ctx, clsName, methodName, desc, args) {
  const cls = ctx.classes.get(clsName)
  const method = cls.methods.find((m) => m.name === methodName && (!desc || m.desc === desc))
  if (!method) throw new Error(`method not found: ${clsName}.${methodName}${desc ?? ''}`)
  const code = findCode(cls, method.name, method.desc)
  if (!code) throw new Error(`no code: ${clsName}.${methodName}`)

  const dv = cls.dv
  const locals = [...args]
  const stack = []
  let p = code.codeStart
  const base = code.codeStart
  let steps = 0

  while (true) {
    if (++steps > 200000) throw new Error(`interpreter runaway in ${clsName}.${methodName}`)
    const op = dv.getUint8(p)
    const at = p - base
    p++
    const jump = (off) => { p = base + at + off }

    if (op === 0x00) continue // nop
    if (op === 0x01) { stack.push(null); continue } // aconst_null
    if (op >= 0x02 && op <= 0x08) { stack.push(op - 0x03); continue } // iconst_m1..5
    if (op >= 0x09 && op <= 0x0a) { stack.push(op - 0x09); continue } // lconst
    if (op >= 0x0b && op <= 0x0d) { stack.push(op - 0x0b); continue } // fconst_0..2
    if (op >= 0x0e && op <= 0x0f) { stack.push(op - 0x0e); continue } // dconst
    if (op === 0x10) { stack.push(dv.getInt8(p)); p += 1; continue } // bipush
    if (op === 0x11) { stack.push(dv.getInt16(p)); p += 2; continue } // sipush
    if (op === 0x12) { stack.push(ldc(cls, dv.getUint8(p))); p += 1; continue }
    if (op === 0x13 || op === 0x14) { stack.push(ldc(cls, dv.getUint16(p))); p += 2; continue } // ldc_w/ldc2_w
    if (op >= 0x15 && op <= 0x19) { stack.push(locals[dv.getUint8(p)]); p += 1; continue } // *load idx
    if (op >= 0x1a && op <= 0x2d) { stack.push(locals[(op - 0x1a) % 4]); continue } // *load_0..3
    if (op >= 0x36 && op <= 0x3a) { locals[dv.getUint8(p)] = stack.pop(); p += 1; continue } // *store idx
    if (op >= 0x3b && op <= 0x4e) { locals[(op - 0x3b) % 4] = stack.pop(); continue } // *store_0..3
    if (op === 0x53) { stack.pop(); stack.pop(); stack.pop(); continue } // aastore
    if (op === 0x57) { stack.pop(); continue } // pop
    if (op === 0x58) { stack.pop(); stack.pop(); continue } // pop2 (slot-sloppy, fine here)
    if (op === 0x59) { stack.push(stack[stack.length - 1]); continue } // dup
    if (op === 0x5a) { stack.splice(stack.length - 2, 0, stack[stack.length - 1]); continue } // dup_x1
    if (op === 0x5f) { stack.push(stack.splice(stack.length - 2, 1)[0]); continue } // swap
    if (op >= 0x85 && op <= 0x93) { continue } // numeric conversions: no-ops for us
    if (op >= 0x99 && op <= 0x9e) { // ifeq..ifle
      const off = dv.getInt16(p); p += 2
      const v = stack.pop()
      if (!isNum(v)) throw new Error(`branch on unknown in ${clsName}.${methodName}@${at}`)
      if ([v === 0, v !== 0, v < 0, v >= 0, v > 0, v <= 0][op - 0x99]) jump(off)
      continue
    }
    if (op >= 0x9f && op <= 0xa4) { // if_icmpeq..le
      const off = dv.getInt16(p); p += 2
      const b = stack.pop(), a = stack.pop()
      if (!isNum(a) || !isNum(b)) throw new Error(`icmp on unknown in ${clsName}.${methodName}@${at}`)
      if ([a === b, a !== b, a < b, a >= b, a > b, a <= b][op - 0x9f]) jump(off)
      continue
    }
    if (op === 0xa5 || op === 0xa6) { // if_acmpeq/ne on refs
      const off = dv.getInt16(p); p += 2
      const b = stack.pop(), a = stack.pop()
      if ((a === b) === (op === 0xa5)) jump(off)
      continue
    }
    if (op === 0xa7) { jump(dv.getInt16(p)); continue } // goto
    if (op === 0xc8) { p = base + at + dv.getInt32(p); continue } // goto_w
    if (op >= 0xac && op <= 0xb0) return stack.pop() // ireturn..areturn
    if (op === 0xb1) return undefined // return
    if (op === 0xb2) { // getstatic -> symbolic field
      const ref = cls.memberRef(dv.getUint16(p)); p += 2
      stack.push({ field: ref.name, fieldCls: ref.cls })
      continue
    }
    if (op === 0xb6 || op === 0xb7 || op === 0xb8 || op === 0xb9) { // invokes
      const ref = cls.memberRef(dv.getUint16(p)); p += 2
      if (op === 0xb9) p += 2 // invokeinterface count+0
      const d = parseDescriptor(ref.desc)
      const callArgs = []
      for (let i = d.args.length - 1; i >= 0; i--) callArgs.unshift(stack.pop())
      const receiver = op === 0xb8 ? undefined : stack.pop()
      const result = handleCall(ctx, ref, d, receiver, callArgs)
      if (result !== undefined) stack.push(result)
      else if (d.ret !== "V") stack.push(OPAQUE)
      continue
    }
    if (op === 0xba) { p += 4; stack.push(OPAQUE); continue } // invokedynamic
    if (op === 0xbb) { const ci = dv.getUint16(p); p += 2; stack.push({ cls: cls.className(ci), props: {} }); continue } // new
    if (op === 0xbc) { p += 1; stack.pop(); stack.push(OPAQUE); continue } // newarray
    if (op === 0xbd) { p += 2; stack.pop(); stack.push(OPAQUE); continue } // anewarray
    if (op === 0xc0) { p += 2; continue } // checkcast passthrough
    throw new Error(`unsupported opcode 0x${op.toString(16)} in ${clsName}.${methodName}@${at}`)
  }
}

function ldc(cls, idx) {
  const v = cls.constVal(idx)
  return v !== undefined ? v : OPAQUE
}

function handleCall(ctx, ref, d, receiver, args) {
  if (ref.name === "<init>") return undefined // object came from new+dup

  // boxing: keep numbers flowing
  if (ref.name === "valueOf" && args.length === 1) return args[0]

  // vanilla's temperature->sky formula, reproduced locally
  if (ref.name === "calculateSkyColor" && isNum(args[0])) return defaultSky(args[0])

  // static no-arg builder() factory (EnvironmentAttributeMap.builder() etc.)
  if (ref.name === "builder" && d.args.length === 0 && receiver === undefined) {
    return { cls: ref.cls, props: {} }
  }

  // named setters write onto their receiver instance
  if (isObj(receiver) && ref.name in SETTERS) {
    const key = SETTERS[ref.name]
    const v = args[0]
    receiver.props[key] = ENUM_PARAMS.has(key)
      ? (v && v.field ? v.field.toLowerCase() : undefined)
      : (isNum(v) ? v : undefined)
    return receiver
  }
  // generic attribute set(attr, value) on a builder-ish object
  if (isObj(receiver) && (ref.name === "set" || ref.name === "setAttribute") && args.length === 2) {
    const [attr, value] = args
    if (attr && attr.field === "SKY_COLOR" && isNum(value)) receiver.props.sky_color = value
    return receiver
  }
  // attach a built effects/attribute object to the biome builder: last wins
  if (isObj(receiver) && args.length === 1 && isObj(args[0]) && Object.keys(args[0].props).length) {
    receiver.props.attached = receiver.props.attached || []
    receiver.props.attached = receiver.props.attached.filter((o) => o.cls !== args[0].cls)
    receiver.props.attached.push(args[0])
    return receiver
  }

  // registration: register(key, biome)
  if (ref.name === "register" && args.length >= 2) {
    const [key, biome] = args.slice(-2)
    if (key && key.field && isObj(biome)) ctx.biomes[key.field.toLowerCase()] = biome
    return OPAQUE
  }

  // calls into the biome data classes: interpret them too
  if (ctx.classes.has(ref.cls)) {
    return runMethod(ctx, ref.cls, ref.name, ref.desc, args)
  }

  // unknown chainable call: keep the receiver flowing (builder chains, build())
  if (receiver !== undefined && d.ret === "L") return isObj(receiver) ? receiver : OPAQUE
  return undefined
}

// Flatten a registered biome-builder object into worldgen-JSON-shaped params.
export function recordsToParams(biomes) {
  const out = {}
  for (const [name, obj] of Object.entries(biomes)) {
    const flat = { ...obj.props }
    for (const att of obj.props.attached ?? []) Object.assign(flat, att.props)
    delete flat.attached
    if (flat.temperature === undefined || flat.downfall === undefined) throw new Error(`missing temp/downfall for ${name}`)

    const effects = {}
    for (const k of ["water_color", "grass_color", "foliage_color", "dry_foliage_color"]) {
      if (isNum(flat[k])) effects[k] = flat[k] & 0xffffff
    }
    if (flat.grass_color_modifier && flat.grass_color_modifier !== "none") effects.grass_color_modifier = flat.grass_color_modifier

    out[name] = {
      temperature: round(flat.temperature),
      downfall: round(flat.downfall),
      ...(flat.temperature_modifier && flat.temperature_modifier !== "none" ? { temperature_modifier: flat.temperature_modifier } : {}),
      effects,
      ...(isNum(flat.sky_color) ? { attributes: { "minecraft:visual/sky_color": flat.sky_color & 0xffffff } } : {}),
    }
  }
  return out
}

// float32 constants (0.8f) -> the shortest double that round-trips, matching JSON
const round = (v) => Number(Math.fround(v).toPrecision(7))
