// Network boundary: download a historical AIS dataset from NOAA Marine
// Cadastre and return parsed records / tracks.
//
// NOTE: This requires outbound access to coast.noaa.gov. In a restricted
// environment (e.g. Claude Code on the web with a closed network policy) the
// fetch will fail with a clear error; the parsing/aggregation modules it builds
// on are fully usable offline and covered by tests.

import { buildHistoricalUrl } from "./noaaUrl.mjs";
import { extractFirstCsv } from "./unzip.mjs";
import { parseAisCsv } from "./parseAis.mjs";
import { buildTracks, filterByBoundingBox, filterByTimeRange } from "./tracks.mjs";

// Download and decode the CSV for a given date. `fetchImpl` is injectable so
// callers (and tests) can supply a stub instead of the global fetch.
export const downloadAisCsv = async (
  date,
  { zone, fetchImpl = globalThis.fetch } = {},
) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation available");
  }

  const url = buildHistoricalUrl(date, { zone });
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`NOAA request failed (${response.status}) for ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return { url, csv: extractFirstCsv(buffer) };
};

// High-level helper: download a day of AIS data and return validated records,
// optionally filtered by bounding box / time range, plus per-vessel tracks.
export const fetchHistoricalAis = async (
  date,
  { zone, boundingBox, timeRange, fetchImpl } = {},
) => {
  const { url, csv } = await downloadAisCsv(date, { zone, fetchImpl });

  let records = parseAisCsv(csv);
  if (boundingBox) {
    records = filterByBoundingBox(records, boundingBox);
  }
  if (timeRange) {
    records = filterByTimeRange(records, timeRange);
  }

  return { url, records, tracks: buildTracks(records) };
};
