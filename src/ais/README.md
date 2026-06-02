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
# Local CSV or zip (offline), with charts:
node scripts/ais-eda.mjs path/to/aisdk-2023-01-01.zip --bbox 55,56.2,12,13 \
  --charts charts/ --out report.md

# Or fetch + analyze in one go (needs network):
node scripts/ais-eda.mjs --date 2023-01-01 --bbox 55,56.2,12,13 --out report.md
```

The report has three parts:

1. **Summary** — record/vessel counts, time range, bounding box, speed (SOG)
   distribution, per-vessel activity and distances, ship-type / status /
   mobile-type breakdowns, field completeness, hourly histogram.
2. **Data-quality audit** — invalid MMSIs, "speed not available" sentinels,
   implausible speeds, position jumps (teleporting fixes), duplicate reports,
   and reporting-gap statistics.
3. **Charts** (with `--charts <dir>`) — standalone **SVG** files: speed
   histogram, records-per-hour bar chart, and a vessel-position map. SVG renders
   in any browser; PNG conversion needs an external tool (rsvg-convert /
   ImageMagick), which isn't bundled.

Programmatic use:

```js
import { computeEda, formatEdaReport } from "./src/ais/eda.mjs";
import { auditQuality, formatQualityReport } from "./src/ais/quality.mjs";
import { histogramSvg, trackMapSvg } from "./src/ais/charts.mjs";

console.log(formatEdaReport(computeEda(records)));
console.log(formatQualityReport(auditQuality(records)));
```

## Focused deep dive (flag + military)

Built for monitoring Russian military/naval transits through the Danish Straits,
but parameterised by flag and military filter.

```bash
# Russian-flagged, military-classified, on a local file:
node scripts/ais-eda.mjs aisdk-2023-01-01.zip --flag RU --military \
  --bbox 54,58,9,14 --out report.md
```

Identification (all from self-declared AIS — see caveats):
- **Flag** = MMSI MID prefix (`getFlagInfo`); **Russia = MID 273**.
- **Military** = AIS ship-type `35` / DMA "Military" text; **law enforcement** = `55`.
  Optional `watchlist` of known MMSIs / name fragments via the API.
- **"Going dark"** = reporting gaps ≥ threshold, flagged per vessel.

```js
import { analyzeFocus, formatFocusReport } from "./src/ais/deepDive.mjs";
const focus = analyzeFocus(records, {
  flagCode: "RU",
  militaryOnly: true,
  gapMinutes: 30,
  watchlist: { mmsi: ["273XXXXXX"], names: ["Admiral", "RFS"] },
});
console.log(formatFocusReport(focus));
```

> ⚠️ **Hard limits.** AIS is self-reported: warships routinely switch it off or
> spoof MMSI/name/type, and DMA only covers Danish/Baltic/North Sea approaches.
> Results are a **floor, not an order of battle** — useful for transit-spotting
> and pattern-of-life on auxiliaries/support ships, not comprehensive coverage.
> Every focus report prints these caveats inline.

## Tests

No dependencies — uses Node's built-in test runner (Node 22+):

```bash
node --test src/ais/__tests__/*.test.mjs
```
