// Classify vessels by military / law-enforcement / SAR character from AIS.
//
// HEAVY CAVEAT: this relies on the AIS "ship type" field, which is self-
// declared. Real warships routinely (a) switch AIS off entirely, or (b) spoof
// their type, name and MMSI. So a positive classification is a lead, and the
// absence of one means nothing. Treat counts as a *floor*.
//
// AIS ship-type codes of interest:
//   35 = Military operations
//   55 = Law enforcement
//   51 = Search and rescue (SAR)

// DMA emits "Ship type" as text; AISStream/raw AIS may give a numeric code.
// Match both. Text categories DMA uses include "Military", "Law enforcement",
// "SAR", etc.
const MILITARY_TEXT = /\bmilit/i;
const LAW_TEXT = /law\s*enforce/i;
const SAR_TEXT = /\bsar\b|search.*rescue/i;

const numericType = (record) => {
  const v = record.shipTypeCode ?? record.aisShipType;
  return typeof v === "number" ? v : null;
};

// Returns { category, signals } where category is one of
// "military" | "law_enforcement" | "sar" | "other".
export const classifyVessel = (record, { watchlist } = {}) => {
  const signals = [];
  const typeText = record.vesselType ?? "";
  const code = numericType(record);

  if (code === 35 || MILITARY_TEXT.test(typeText)) signals.push("ais_type_military");
  if (code === 55 || LAW_TEXT.test(typeText)) signals.push("ais_type_law_enforcement");
  if (code === 51 || SAR_TEXT.test(typeText)) signals.push("ais_type_sar");

  // Optional watchlist of known MMSIs / name fragments (user-supplied), e.g. a
  // curated list of Russian naval auxiliaries. Names are matched case-insensitively.
  if (watchlist) {
    const mmsiSet = watchlist.mmsi ? new Set(watchlist.mmsi.map(String)) : null;
    if (mmsiSet?.has(record.mmsi)) signals.push("watchlist_mmsi");
    const name = (record.vesselName ?? "").toLowerCase();
    if (name && watchlist.names?.some((n) => name.includes(n.toLowerCase()))) {
      signals.push("watchlist_name");
    }
  }

  let category = "other";
  if (signals.some((s) => s.includes("military") || s.startsWith("watchlist"))) {
    category = "military";
  } else if (signals.includes("ais_type_law_enforcement")) {
    category = "law_enforcement";
  } else if (signals.includes("ais_type_sar")) {
    category = "sar";
  }

  return { category, signals };
};

export const isMilitary = (record, opts) =>
  classifyVessel(record, opts).category === "military";

export const isLawEnforcement = (record, opts) =>
  classifyVessel(record, opts).category === "law_enforcement";
