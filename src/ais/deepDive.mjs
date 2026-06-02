// Focused deep-dive analysis, built for "Russian military/naval vessels in DMA
// coverage" but parameterised by flag and military filter.
//
// Reads as: of the vessels that *self-identify* (via AIS) as the target flag
// and/or as military, what were their movements, speed profiles, and AIS
// reporting gaps ("going dark") while transiting Danish/Baltic waters?
//
// See the CAVEATS constant — this is a floor, not a complete order of battle.

import { haversineNm, summarize } from "./eda.mjs";
import { getFlagInfo } from "./flags.mjs";
import { classifyVessel } from "./classify.mjs";

export const CAVEATS = [
  "AIS is self-reported: warships routinely disable AIS or spoof MMSI/name/type.",
  "Counts are a FLOOR — absence of a vessel means nothing.",
  "Flag is derived from the MMSI MID prefix, which can be falsified.",
  "Military classification relies on the self-declared AIS ship-type (rarely honest for combatants).",
  "DMA coverage is Danish straits / western Baltic / North Sea approaches only.",
  "Reporting gaps may be deliberate ('going dark') OR mundane receiver coverage holes.",
];

const groupByMmsi = (records) => {
  const byMmsi = new Map();
  for (const r of records) {
    if (r.mmsi == null) continue;
    if (!byMmsi.has(r.mmsi)) byMmsi.set(r.mmsi, []);
    byMmsi.get(r.mmsi).push(r);
  }
  for (const recs of byMmsi.values()) {
    recs.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }
  return byMmsi;
};

// Per-vessel profile incl. distance, speed, and "going dark" gap events.
const profileVessel = (mmsi, recs, { gapMinutes }) => {
  const flag = getFlagInfo(mmsi);
  const { category, signals } = classifyVessel(recs[0]);
  // Re-classify across all points so a single honest ping is enough to flag it.
  let cat = category;
  let sig = new Set(signals);
  for (const r of recs) {
    const c = classifyVessel(r);
    for (const s of c.signals) sig.add(s);
    if (c.category === "military") cat = "military";
    else if (cat === "other" && c.category !== "other") cat = c.category;
  }

  let distanceNm = 0;
  const darkEvents = [];
  let maxSog = null;
  for (let i = 0; i < recs.length; i += 1) {
    const r = recs[i];
    if (r.sog != null) maxSog = maxSog == null ? r.sog : Math.max(maxSog, r.sog);
    if (i === 0) continue;
    const prev = recs[i - 1];
    if (prev.lat != null && prev.lon != null && r.lat != null && r.lon != null) {
      distanceNm += haversineNm(prev.lat, prev.lon, r.lat, r.lon);
    }
    const gapMin = (Date.parse(r.timestamp) - Date.parse(prev.timestamp)) / 6e4;
    if (gapMin >= gapMinutes) {
      darkEvents.push({
        from: prev.timestamp,
        to: r.timestamp,
        minutes: Math.round(gapMin),
        lastLat: prev.lat,
        lastLon: prev.lon,
      });
    }
  }

  const startMs = Date.parse(recs[0].timestamp);
  const endMs = Date.parse(recs[recs.length - 1].timestamp);
  return {
    mmsi,
    flag: flag.name,
    name: recs.find((r) => r.vesselName)?.vesselName ?? null,
    type: recs.find((r) => r.vesselType)?.vesselType ?? null,
    category: cat,
    signals: [...sig],
    points: recs.length,
    firstSeen: recs[0].timestamp,
    lastSeen: recs[recs.length - 1].timestamp,
    hoursInCoverage: (endMs - startMs) / 3.6e6,
    distanceNm,
    maxSog,
    darkEvents,
  };
};

// Run the analysis. Options:
//   flagCode     – ISO flag to focus on (default "RU"; null = any)
//   militaryOnly – keep only military-classified vessels
//   gapMinutes   – threshold for a "going dark" gap event (default 30)
//   watchlist    – { mmsi:[], names:[] } passed to the classifier
export const analyzeFocus = (records, {
  flagCode = "RU",
  militaryOnly = false,
  gapMinutes = 30,
  watchlist,
} = {}) => {
  const byMmsi = groupByMmsi(records);
  const vessels = [];
  for (const [mmsi, recs] of byMmsi) {
    if (flagCode && getFlagInfo(mmsi).code !== flagCode) continue;
    const profile = profileVessel(mmsi, recs, { gapMinutes });
    if (watchlist) {
      // Fold watchlist signals/category in.
      const c = classifyVessel({ ...recs[0], vesselName: profile.name }, { watchlist });
      if (c.category === "military") profile.category = "military";
      profile.signals = [...new Set([...profile.signals, ...c.signals])];
    }
    if (militaryOnly && profile.category !== "military") continue;
    vessels.push(profile);
  }
  vessels.sort((a, b) => b.distanceNm - a.distanceNm);

  const byCategory = {};
  for (const v of vessels) byCategory[v.category] = (byCategory[v.category] ?? 0) + 1;

  return {
    flagCode,
    militaryOnly,
    gapMinutes,
    matchedVessels: vessels.length,
    totalRecordsScanned: records.length,
    byCategory,
    darkEventCount: vessels.reduce((n, v) => n + v.darkEvents.length, 0),
    distanceNm: summarize(vessels.map((v) => v.distanceNm)),
    vessels,
  };
};

const num = (v, d = 1) => (v == null ? "n/a" : Number(v).toFixed(d));

export const formatFocusReport = (a) => {
  const lines = [];
  const add = (s = "") => lines.push(s);
  const target = a.flagCode ? `${a.flagCode}-flagged` : "all-flag";

  add(`# Deep dive: ${target}${a.militaryOnly ? " military/naval" : ""} vessels (AIS)`);
  add();
  add("> **Methodology caveats — read first:**");
  for (const c of CAVEATS) add(`> - ${c}`);
  add();
  add("## Summary");
  add(`- Records scanned: ${a.totalRecordsScanned.toLocaleString()}`);
  add(`- Matched vessels: **${a.matchedVessels}**`);
  add(`- By classification: ${Object.entries(a.byCategory).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  add(`- "Going dark" gap events (≥${a.gapMinutes} min): **${a.darkEventCount}**`);
  add(`- Distance in coverage (nm): median ${num(a.distanceNm.median)}, max ${num(a.distanceNm.max)}`);
  add();

  add("## Matched vessels");
  if (a.vessels.length === 0) {
    add("_None in this dataset._");
  } else {
    add("| MMSI | Name | Type | Class | Pts | Hrs | Dist (nm) | Max SOG | Dark |");
    add("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |");
    for (const v of a.vessels) {
      add(`| ${v.mmsi} | ${v.name ?? ""} | ${v.type ?? ""} | ${v.category} | ${v.points} | ${num(v.hoursInCoverage)} | ${num(v.distanceNm)} | ${num(v.maxSog)} | ${v.darkEvents.length} |`);
    }
  }
  add();

  const withDark = a.vessels.filter((v) => v.darkEvents.length > 0);
  if (withDark.length > 0) {
    add("## Possible 'going dark' events");
    add("_Reporting gaps that may indicate AIS switched off — corroborate before concluding._");
    for (const v of withDark) {
      add(`### ${v.name ?? v.mmsi} (${v.mmsi})`);
      for (const e of v.darkEvents) {
        add(`- ${e.from} → ${e.to} (${e.minutes} min); last fix ${num(e.lastLat, 3)}, ${num(e.lastLon, 3)}`);
      }
    }
  }

  return lines.join("\n");
};
