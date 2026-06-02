# AIS data integration

Pulls vessel (AIS) data into a single record shape, aggregates positions into
per-vessel tracks, and runs exploratory data analysis.

| Source | Kind | Backfills past? | Key needed | Status here |
| --- | --- | --- | --- | --- |
| **Danish Maritime Authority (DMA)** | Historical archive (Danish/Baltic/North Sea, ~2006→) | ✅ Yes | No | Parsing works offline; download needs `web.ais.dk` |
| **AISStream.io** | Live WebSocket stream | ❌ No (forward-only) | Yes | Needs `aisstream.io` + `AISSTREAM_API_KEY` |

> **Why DMA for history?** AISHub, AISStream and BarentsWatch are *live*
> services — they report current/streaming positions only. The DMA open archive
> publishes free daily zipped CSVs of past AIS, so it's the historical source.

## Network note (Claude Code on the web)

Outbound access is governed by the environment's network policy. Under a closed
policy, `web.ais.dk` and `aisstream.io` are unreachable (`host_not_allowed` /
DNS blocked). The parsing/aggregation/EDA code runs fully offline and is covered
by tests; the `fetch*`/`collect*` functions are the network boundary and need an
environment whose policy allowlists those hosts. See
https://code.claude.com/docs/en/claude-code-on-the-web

## Historical (DMA)

```js
import { fetchDmaAis } from "./src/ais/index.mjs";

// One day of Danish AIS, filtered to the Øresund / Copenhagen area.
const { records, tracks } = await fetchDmaAis("2023-01-01", {
  boundingBox: { minLat: 55.0, maxLat: 56.2, minLon: 12.0, maxLon: 13.0 },
});
```

DMA daily files are large (often >1 GB uncompressed) — prefer a `boundingBox` /
`timeRange`. Older years use monthly files: pass `{ granularity: "monthly" }`.

Already have a downloaded zip/CSV? Skip the network entirely:

```js
import { extractFirstCsv } from "./src/ais/unzip.mjs";
import { parseDmaCsv } from "./src/ais/parseDmaAis.mjs";
import { buildTracks } from "./src/ais/tracks.mjs";

const csv = extractFirstCsv(zipBuffer);   // or read a .csv directly
const tracks = buildTracks(parseDmaCsv(csv));
```

## Live (AISStream)

Provide the key via the environment — **never hardcode or commit it**:

```bash
export AISSTREAM_API_KEY="…"
```

```js
import { collectAisStream } from "./src/ais/index.mjs";

const handle = collectAisStream({
  boundingBoxes: [[[55.0, 12.0], [56.2, 13.0]]],
  onRecord: (r) => save(r),   // same record shape as DMA → feed buildTracks
});
// later: handle.stop();
```

## Exploratory data analysis

```bash
# Local CSV or zip (offline):
node scripts/ais-eda.mjs path/to/aisdk-2023-01-01.zip --bbox 55,56.2,12,13

# Or fetch + analyze in one go (needs network):
node scripts/ais-eda.mjs --date 2023-01-01 --bbox 55,56.2,12,13 --out report.md
```

Produces an overview (record/vessel counts, time range, bounding box), speed
distribution, per-vessel activity and distances, ship-type / status / mobile-type
breakdowns, field completeness, and an hourly histogram. Programmatic use:

```js
import { computeEda, formatEdaReport } from "./src/ais/eda.mjs";
console.log(formatEdaReport(computeEda(records)));
```

## Tests

No dependencies — uses Node's built-in test runner (Node 22+):

```bash
node --test src/ais/__tests__/*.test.mjs
```
