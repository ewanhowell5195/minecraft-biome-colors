// ZIP reader over HTTP range requests: fetch the tail to get the central
// directory, then fetch only the entries actually read. Same interface as
// zip.js's openZip. Mojang's piston-data CDN supports ranges.
import { inflateRaw } from "./inflate.js"

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const TAIL = 128 * 1024 // EOCD + typically the whole central directory

export async function openRemoteZip(url) {
  const head = await fetch(url, { method: "HEAD" })
  if (!head.ok) throw new Error(`HEAD ${head.status} ${url}`)
  const total = Number(head.headers.get("Content-Length"))
  if (!total) throw new Error("no content-length")

  const range = async (start, end) => {
    const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
    if (r.status !== 206) throw new Error(`range not supported (${r.status})`)
    return new Uint8Array(await r.arrayBuffer())
  }

  let tailStart = Math.max(0, total - TAIL)
  let tail = await range(tailStart, total - 1)
  let dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)

  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error("no EOCD in tail")
  const count = dv.getUint16(eocd + 10, true)
  const cdSize = dv.getUint32(eocd + 12, true)
  const cdOffset = dv.getUint32(eocd + 16, true)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("zip64 not supported")

  // ensure we hold the whole central directory
  if (cdOffset < tailStart) {
    tail = await range(cdOffset, total - 1)
    tailStart = cdOffset
    dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  }

  const entries = new Map()
  let p = cdOffset - tailStart
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== CEN_SIG) throw new Error("bad central dir at " + p)
    const method = dv.getUint16(p + 10, true)
    const compSize = dv.getUint32(p + 20, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOffset = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(tail.subarray(p + 46, p + 46 + nameLen))
    entries.set(name, { method, compSize, size, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }

  const readEntry = async (e) => {
    // local header is 30 bytes + name + extra; extra can differ from the
    // central directory's, so fetch the header first to size it exactly
    const lh = await range(e.localOffset, e.localOffset + 29)
    const lhdv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength)
    const nameLen = lhdv.getUint16(26, true)
    const extraLen = lhdv.getUint16(28, true)
    const start = e.localOffset + 30 + nameLen + extraLen
    const comp = await range(start, start + e.compSize - 1)
    if (e.method === 0) return comp
    if (e.method === 8) return inflateRaw(comp)
    throw new Error("unsupported zip method " + e.method)
  }
  const read = (name) => {
    const e = entries.get(name)
    return e ? readEntry(e) : null
  }

  return { entries, read, readEntry }
}
