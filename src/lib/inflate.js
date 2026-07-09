// ZIP entries are raw deflate; PNG IDAT is zlib-wrapped
let _zlib // undefined = untried, null = unavailable

async function nodeZlib() {
  if (_zlib === undefined) {
    try { _zlib = await import("node:zlib") } catch { _zlib = null }
  }
  return _zlib
}

async function inflateWith(bytes, format, sync) {
  const z = await nodeZlib()
  if (z && z[sync]) return z[sync](bytes)
  const ds = new DecompressionStream(format)
  const ab = await new Response(new Response(bytes).body.pipeThrough(ds)).arrayBuffer()
  return new Uint8Array(ab)
}

export const inflateRaw = (bytes) => inflateWith(bytes, "deflate-raw", "inflateRawSync")
export const inflateZlib = (bytes) => inflateWith(bytes, "deflate", "inflateSync")

export async function sha256hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}
