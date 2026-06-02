// AIS data integration.
//
// Two sources, one record shape:
//   * Danish Maritime Authority (DMA) — historical/past AIS for Danish & nearby
//     waters (free, no key). Open archive at web.ais.dk. Use the fetch + parse
//     + tracks modules; parsing works offline once you have a CSV/zip.
//   * AISStream — live stream for accumulating data going forward (needs an
//     API key via AISSTREAM_API_KEY and outbound network access).

export {
  buildDailyUrl,
  buildMonthlyUrl,
  buildHistoricalUrl,
} from "./dmaUrl.mjs";
export { parseCsvRows, parseCsvObjects } from "./parseCsv.mjs";
export {
  toDmaRecord,
  isValidDmaRecord,
  parseDmaCsv,
  parseDmaTimestamp,
} from "./parseDmaAis.mjs";
export { extractZipEntries, extractFirstCsv } from "./unzip.mjs";
export {
  buildTracks,
  filterByBoundingBox,
  filterByTimeRange,
} from "./tracks.mjs";
export { downloadDmaCsv, fetchDmaAis } from "./fetchDmaAis.mjs";
export {
  quantile,
  summarize,
  valueCounts,
  haversineNm,
  computeEda,
  formatEdaReport,
} from "./eda.mjs";
export { isValidMmsi, auditQuality, formatQualityReport } from "./quality.mjs";
export { histogram, histogramSvg, barChartSvg, trackMapSvg } from "./charts.mjs";
export {
  resolveApiKey,
  buildSubscription,
  normalizeAisStreamMessage,
  collectAisStream,
} from "./aisStream.mjs";
