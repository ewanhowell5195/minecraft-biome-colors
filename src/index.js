import { extractColormap, UnsupportedVersion, EXTRACTOR_V } from "./live.js"

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
const ORIGINS = /^https:\/\/ewanhowell\.com$|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
const FLOOR = "1.16.2" // oldest supported version (biome-data era floor)

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin")
    const cors = origin && ORIGINS.test(origin)
      ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, OPTIONS", Vary: "Origin" }
      : { Vary: "Origin" }
    const json = (body, status = 200, extra = {}) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", ...extra } })

    if (request.method === "OPTIONS") return new Response(null, { headers: cors })
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405)

    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, "") || "/"
    try {
      if (path === "/") return json({ service: "minecraft-biome-colors", endpoints: ["/versions", "/colormap/:version", "/texture/:hash"] })
      if (path === "/versions") return await handleVersions(ctx, json)
      let m
      if ((m = path.match(/^\/colormap\/(.+)$/))) return await handleColormap(env, ctx, decodeURIComponent(m[1]), cors, json)
      if ((m = path.match(/^\/texture\/([0-9a-f]{64})$/))) return await handleTexture(env, m[1], cors, json)
      return json({ error: "not found" }, 404)
    } catch (e) {
      return json({ error: e.message || String(e) }, 500)
    }
  },
}

async function handleVersions(ctx, json) {
  const manifest = await (await fetch(MANIFEST, { cf: { cacheTtl: 3600, cacheEverything: true } })).json()
  const releases = manifest.versions.filter((v) => v.type === "release")
  const floor = releases.findIndex((v) => v.id === FLOOR)
  const versions = releases
    .slice(0, floor + 1)
    .map((v) => ({ id: v.id, releaseTime: v.releaseTime }))
  // the latest snapshot is supported too (older snapshots are not)
  const snap = manifest.versions.find((v) => v.id === manifest.latest.snapshot)
  if (snap && snap.type !== "release") versions.unshift({ id: snap.id, releaseTime: snap.releaseTime, snapshot: true })
  const body = { latest: manifest.latest.release, versions }
  return json(body, 200, { "Cache-Control": "public, max-age=3600" })
}

// concurrent requests for the same uncached version share one extraction
const inflight = new Map()

async function handleColormap(env, ctx, version, cors, json) {
  const cached = await env.COLORMAPS.get(version)
  if (cached) return new Response(cached, { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } })

  try {
    let pending = inflight.get(version)
    if (!pending) {
      pending = (async () => {
        const doc = await extractColormap(env, version)
        const value = JSON.stringify(doc)
        // only validated results are ever cached (the cache is permanent)
        ctx.waitUntil(env.COLORMAPS.put(version, value, { metadata: { extractorV: EXTRACTOR_V } }))
        return value
      })().finally(() => inflight.delete(version))
      inflight.set(version, pending)
    }
    const value = await pending
    return new Response(value, { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } })
  } catch (e) {
    if (e instanceof UnsupportedVersion) return json({ error: e.message, version }, 400)
    return json({ error: "extraction failed", version, detail: e.message }, 502)
  }
}

async function handleTexture(env, hash, cors, json) {
  const obj = await env.TEXTURES.get(`${hash}.png`)
  if (!obj) return json({ error: "texture not found", hash }, 404)
  return new Response(obj.body, {
    headers: { ...cors, "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable", ETag: `"${hash}"` },
  })
}
