import { inflateZlib } from "./inflate.js"

const OUT_OF_RANGE = 0xff00ff

export const clamp01 = (v) => Math.max(0, Math.min(1, v))
export const hex = (n) => "#" + (n & 0xffffff).toString(16).padStart(6, "0")
// biome color values are int (old datapacks) or "#rrggbb" (26.x+); normalize to hex
export const toHex = (c) =>
  c == null ? null : typeof c === "number" ? hex(c >>> 0) : c[0] === "#" ? c.toLowerCase() : "#" + c.toLowerCase()

export async function decodePng(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0) !== 0x89504e47) throw new Error("not a png")
  let off = 8, w = 0, h = 0, colorType = 0, bitDepth = 0
  const idat = []
  while (off < buf.length) {
    const len = dv.getUint32(off)
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7])
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === "IHDR") { w = dv.getUint32(off + 8); h = dv.getUint32(off + 12); bitDepth = buf[off + 16]; colorType = buf[off + 17] }
    else if (type === "IDAT") idat.push(data)
    else if (type === "IEND") break
    off += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`unsupported png ${colorType}/${bitDepth}`)
  const raw = await inflateZlib(concat(idat))
  const bpp = colorType === 6 ? 4 : 3, stride = w * bpp
  const rgb = new Uint8Array(w * h * 3)
  let prev = new Uint8Array(stride), p = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[p++]
    const line = raw.subarray(p, p + stride); p += stride
    const cur = new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      cur[i] = v & 0xff
    }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 3, s = x * bpp; rgb[o] = cur[s]; rgb[o + 1] = cur[s + 1]; rgb[o + 2] = cur[s + 2] }
    prev = cur
  }
  return { w, h, rgb }
}

// Vanilla colormap lookup at sea level (no altitude adjustment).
export function sample(png, temperature, downfall) {
  const t = clamp01(temperature), d = clamp01(downfall) * t
  const x = Math.floor((1 - t) * 255), y = Math.floor((1 - d) * 255)
  if (x < 0 || x > 255 || y < 0 || y > 255) return OUT_OF_RANGE
  const i = (y * png.w + x) * 3
  return (png.rgb[i] << 16) | (png.rgb[i + 1] << 8) | png.rgb[i + 2]
}

export function applyGrassModifier(color, modifier) {
  if (modifier === "dark_forest") return ((color & 0xfefefe) + 0x28340a) >> 1
  if (modifier === "swamp") return 0x6a7039 // deterministic default (noise term ignored)
  return color
}

// Vanilla default sky color (Biome.calculateSkyColor): hue from temperature.
// Bit-exact float32 replication of Mth.hsvToRgb, incl. (int) truncation.
const fr = Math.fround
function hsvToRgb(h, s, v) {
  const i = (fr(h * 6) | 0) % 6
  const f = fr(fr(h * 6) - i)
  const p = fr(v * fr(1 - s)), q = fr(v * fr(1 - fr(f * s))), t = fr(v * fr(1 - fr(fr(1 - f) * s)))
  let r, g, b
  switch (i) {
    case 0: [r, g, b] = [v, t, p]; break; case 1: [r, g, b] = [q, v, p]; break
    case 2: [r, g, b] = [p, v, t]; break; case 3: [r, g, b] = [p, q, v]; break
    case 4: [r, g, b] = [t, p, v]; break; default: [r, g, b] = [v, p, q]
  }
  return ((fr(r * 255) | 0) << 16) | ((fr(g * 255) | 0) << 8) | (fr(b * 255) | 0)
}
export function defaultSky(temperature) {
  const f = Math.max(-1, Math.min(1, fr(fr(temperature) / 3)))
  return hsvToRgb(fr(0.62222224 - fr(f * 0.05)), fr(0.5 + fr(f * 0.1)), 1)
}

function concat(chunks) {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}
