// Network boundary: download a day (or month) of historical AIS from the
// Danish Maritime Authority open archive and return parsed records / tracks.
//
// NOTE: Requires outbound access to web.ais.dk. Under a closed network policy
// (e.g. Claude Code on the web) the fetch fails with a clear error; the
// parsing/aggregation it builds on is fully usable offline and covered by tests.

import { buildHistoricalUrl } from "./dmaUrl.mjs";
import { extractFirstCsv } from "./unzip.mjs";
import { parseDmaCsv } from "./parseDmaAis.mjs";
import { buildTracks, filterByBoundingBox, filterByTimeRange } from "./tracks.mjs";

// Download and decode the CSV for a given date. `fetchImpl` is injectable so
// callers (and tests) can supply a stub instead of the global fetch.
export const downloadDmaCsv = async (
  date,
  { granularity, fetchImpl = globalThis.fetch } = {},
) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation available");
  }

  const url = buildHistoricalUrl(date, { granularity });
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`DMA request failed (${response.status}) for ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return { url, csv: extractFirstCsv(buffer) };
};

// High-level helper: download AIS data and return validated records, optionally
// filtered by bounding box / time range, plus per-vessel tracks.
//
// DMA daily files are large (often >1 GB uncompressed); prefer a boundingBox /
// timeRange to keep the result manageable.
export const fetchDmaAis = async (
  date,
  { granularity, boundingBox, timeRange, fetchImpl } = {},
) => {
  const { url, csv } = await downloadDmaCsv(date, { granularity, fetchImpl });

  let records = parseDmaCsv(csv);
  if (boundingBox) {
    records = filterByBoundingBox(records, boundingBox);
  }
  if (timeRange) {
    records = filterByTimeRange(records, timeRange);
  }

  return { url, records, tracks: buildTracks(records) };
};
