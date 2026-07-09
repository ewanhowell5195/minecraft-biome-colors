import { inflateRaw } from "./inflate.js"

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50

export function openZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0x10000; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error("no EOCD (zip64 or corrupt)")

  const count = dv.getUint16(eocd + 10, true)
  const cdOffset = dv.getUint32(eocd + 16, true)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("zip64 not supported")

  const entries = new Map() // name -> { method, compSize, size, localOffset }
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== CEN_SIG) throw new Error("bad central dir at " + p)
    const method = dv.getUint16(p + 10, true)
    const compSize = dv.getUint32(p + 20, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOffset = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen))
    entries.set(name, { method, compSize, size, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }

  const readEntry = async (e) => {
    const lh = e.localOffset
    const nameLen = dv.getUint16(lh + 26, true)
    const extraLen = dv.getUint16(lh + 28, true)
    const start = lh + 30 + nameLen + extraLen
    const comp = buf.subarray(start, start + e.compSize)
    if (e.method === 0) return comp // stored
    if (e.method === 8) return inflateRaw(comp) // deflate
    throw new Error("unsupported zip method " + e.method)
  }
  const read = (name) => {
    const e = entries.get(name)
    return e ? readEntry(e) : null
  }

  return { entries, read, readEntry }
}
