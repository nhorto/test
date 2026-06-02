# AIS data integration

Pulls vessel (AIS) data from two sources into a single record shape, then
aggregates positions into per-vessel tracks.

| Source | Kind | Backfills past? | Key needed | Status here |
| --- | --- | --- | --- | --- |
| **NOAA Marine Cadastre** | Historical archive (US, 2009→) | ✅ Yes | No | Parsing works offline; download needs `coast.noaa.gov` |
| **AISStream.io** | Live WebSocket stream | ❌ No (forward-only) | Yes | Needs `aisstream.io` + `AISSTREAM_API_KEY` |

> **Why not AISHub / AISStream for history?** Both are *live* services — they
> only report current/streaming positions and cannot return past data. For true
> historical tracks use NOAA. AISStream is for *accumulating* history going
> forward.

## Network note (Claude Code on the web)

Outbound access is governed by the environment's network policy. Under a closed
policy, both `coast.noaa.gov` and `aisstream.io` return `host_not_allowed`. The
pure parsing/aggregation code runs fully offline and is covered by tests; the
`fetch*`/`collect*` functions are the network boundary and need an environment
whose policy allowlists those hosts. See
https://code.claude.com/docs/en/claude-code-on-the-web

## Historical (NOAA)

```js
import { fetchHistoricalAis } from "./src/ais/index.mjs";

// One day of US AIS, filtered to New York harbor.
const { records, tracks } = await fetchHistoricalAis("2023-01-01", {
  boundingBox: { minLat: 40.4, maxLat: 40.9, minLon: -74.3, maxLon: -73.7 },
});
```

Pre-2015 data is stored per UTM zone, so pass `{ zone }`:

```js
await fetchHistoricalAis("2012-06-15", { zone: 10 });
```

Already have a downloaded zip/CSV? Skip the network entirely:

```js
import { extractFirstCsv } from "./src/ais/unzip.mjs";
import { parseAisCsv } from "./src/ais/parseAis.mjs";
import { buildTracks } from "./src/ais/tracks.mjs";

const csv = extractFirstCsv(zipBuffer);      // or read a .csv directly
const tracks = buildTracks(parseAisCsv(csv));
```

## Live (AISStream)

Provide the key via the environment — **never hardcode or commit it**:

```bash
export AISSTREAM_API_KEY="…"
```

```js
import { collectAisStream } from "./src/ais/index.mjs";

const handle = collectAisStream({
  boundingBoxes: [[[40.4, -74.3], [40.9, -73.7]]],
  onRecord: (r) => save(r),   // same record shape as NOAA → feed buildTracks
  onError: (e) => console.error(e),
});
// later: handle.stop();
```

## Tests

No dependencies — uses Node's built-in test runner (Node 22+):

```bash
node --test src/ais/__tests__/*.test.mjs
```
