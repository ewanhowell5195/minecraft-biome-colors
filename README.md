# minecraft-biome-colors

Cloudflare Worker that serves version-accurate Minecraft biome color data: per-biome
temperature, downfall, and baked grass/foliage/dry foliage/water/sky colors, plus the
vanilla colormap textures. Clients render it however they like (OptiFine grid colormaps,
the vanilla temperature/humidity triangle, reference charts).

## API

- `GET /versions`: Minecraft release versions
- `GET /colormap/:version`: biome color JSON for a version
- `GET /texture/:hash`: colormap PNG by content hash

Results are cached permanently (KV for JSON, R2 for textures); each version is immutable
so it is only ever computed once.

## How data is produced

Biome numeric ids (grid column order) are read straight from the client jar: the
`Biomes` class registration order, parsed from bytecode in JS (src/lib/classparse.js),
no JVM needed. Works on obfuscated jars too since biome name strings survive obfuscation.

- **Backfill (1.16.2 and newer):** `npm run export` writes every release to `backfill/data/`
  (params from misode/mcmeta, ids + textures from the jar), `npm run textures` saves the
  unique colormap PNGs, `npm run upload` loads both into KV/R2.
- **Live (future 26.x+ releases):** on cache miss the Worker range-reads the client jar,
  abstractly interprets the biome builder bytecode for params (src/lib/biomeparams.js),
  builds the same doc as the backfill, validates against known anchors, and only then
  caches. Snapshots and pre-1.16.2 versions are rejected.

## Dev

```
npm install
npm run dev      # local worker
npm run deploy
```

Create the bindings once: `wrangler kv namespace create COLORMAPS` (paste the id into
wrangler.jsonc) and `wrangler r2 bucket create colormap-textures`.
