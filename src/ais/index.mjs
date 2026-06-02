// AIS data integration.
//
// Two sources, one record shape:
//   * NOAA Marine Cadastre — historical/past AIS (free, no key). Use the
//     fetch + parse + tracks modules. Works offline once you have a CSV/zip.
//   * AISStream — live stream for accumulating data going forward (needs an
//     API key via AISSTREAM_API_KEY and outbound network access).

export { buildDailyUrl, buildZoneUrl, buildHistoricalUrl } from "./noaaUrl.mjs";
export { parseCsvRows, parseCsvObjects } from "./parseCsv.mjs";
export { toAisRecord, isValidAisRecord, parseAisCsv } from "./parseAis.mjs";
export { extractZipEntries, extractFirstCsv } from "./unzip.mjs";
export {
  buildTracks,
  filterByBoundingBox,
  filterByTimeRange,
} from "./tracks.mjs";
export { downloadAisCsv, fetchHistoricalAis } from "./fetchHistoricalAis.mjs";
export {
  resolveApiKey,
  buildSubscription,
  normalizeAisStreamMessage,
  collectAisStream,
} from "./aisStream.mjs";
