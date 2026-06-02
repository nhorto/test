// Focused deep-dive analysis, built for "Russian military/naval vessels in DMA
// coverage" but parameterised by flag and scope.
//
// Scope model (default "interest"): a flagged vessel is included if it is
// classified military OR law-enforcement/coast-guard, OR it exhibits a
// behavioural flag (going dark, loitering, near infrastructure, identity
// change). This catches naval/intelligence vessels that squawk as civilian
// without dragging in all ordinary merchant traffic.
//
// See the CAVEATS constant — this is a floor, not a complete order of battle.

import { haversineNm, summarize } from "./eda.mjs";
import { getFlagInfo } from "./flags.mjs";
import { classifyVessel } from "./classify.mjs";
import { detectBehaviour } from "./behaviour.mjs";

export const CAVEATS = [
  "AIS is self-reported: warships routinely disable AIS or spoof MMSI/name/type.",
  "Counts are a FLOOR — absence of a vessel means nothing.",
  "Flag is derived from the MMSI MID prefix, which can be falsified.",
  "Military classification relies on the self-declared AIS ship-type (rarely honest for combatants).",
  "DMA coverage is Danish straits / western Baltic / North Sea approaches only.",
  "Behavioural flags (going dark, loitering, identity changes) are circumstantial — corroborate before concluding.",
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

// Per-vessel profile: classification, movement, and behavioural flags/events.
const profileVessel = (mmsi, recs, opts) => {
  const flag = getFlagInfo(mmsi);

  // Classify across all points so a single honest ping is enough to flag it.
  let category = "other";
  const signals = new Set();
  for (const r of recs) {
    const c = classifyVessel(r, { watchlist: opts.watchlist });
    for (const s of c.signals) signals.add(s);
    if (c.category === "military") category = "military";
    else if (category === "other" && c.category !== "other") category = c.category;
  }

  let distanceNm = 0;
  let maxSog = null;
  for (let i = 0; i < recs.length; i += 1) {
    const r = recs[i];
    if (r.sog != null) maxSog = maxSog == null ? r.sog : Math.max(maxSog, r.sog);
    if (i === 0) continue;
    const prev = recs[i - 1];
    if (prev.lat != null && prev.lon != null && r.lat != null && r.lon != null) {
      distanceNm += haversineNm(prev.lat, prev.lon, r.lat, r.lon);
    }
  }

  const behaviour = detectBehaviour(recs, opts);
  const startMs = Date.parse(recs[0].timestamp);
  const endMs = Date.parse(recs[recs.length - 1].timestamp);

  return {
    mmsi,
    flag: flag.name,
    name: recs.find((r) => r.vesselName)?.vesselName ?? null,
    type: recs.find((r) => r.vesselType)?.vesselType ?? null,
    category,
    signals: [...signals],
    behaviourFlags: behaviour.flags,
    points: recs.length,
    firstSeen: recs[0].timestamp,
    lastSeen: recs[recs.length - 1].timestamp,
    hoursInCoverage: (endMs - startMs) / 3.6e6,
    distanceNm,
    maxSog,
    behaviour,
  };
};

// Decide whether a profiled vessel is in scope.
//   "interest" (default): military OR law_enforcement OR any behavioural flag
//   "military"          : military only
//   "le"                : military OR law_enforcement
//   "all"               : every flagged vessel
const inScope = (v, scope) => {
  const isMil = v.category === "military";
  const isLe = v.category === "law_enforcement";
  switch (scope) {
    case "all": return true;
    case "military": return isMil;
    case "le": return isMil || isLe;
    case "interest":
    default: return isMil || isLe || v.behaviourFlags.length > 0;
  }
};

// Run the analysis. Options:
//   flagCode       – ISO flag to focus on (default "RU"; null = any)
//   scope          – "interest" | "military" | "le" | "all" (default "interest")
//   gapMinutes     – "going dark" gap threshold (default 30)
//   loiterSpeed/loiterMinutes – loitering thresholds
//   infrastructure – [{ lat, lon, name }] assets to flag proximity to
//   watchlist      – { mmsi:[], names:[] } passed to the classifier
export const analyzeFocus = (records, options = {}) => {
  const {
    flagCode = "RU",
    scope = "interest",
    gapMinutes = 30,
  } = options;
  const opts = { gapMinutes, ...options };

  const byMmsi = groupByMmsi(records);
  const vessels = [];
  for (const [mmsi, recs] of byMmsi) {
    if (flagCode && getFlagInfo(mmsi).code !== flagCode) continue;
    const profile = profileVessel(mmsi, recs, opts);
    if (inScope(profile, scope)) vessels.push(profile);
  }
  vessels.sort((a, b) => b.distanceNm - a.distanceNm);

  const byCategory = {};
  const byBehaviour = {};
  for (const v of vessels) {
    byCategory[v.category] = (byCategory[v.category] ?? 0) + 1;
    for (const f of v.behaviourFlags) byBehaviour[f] = (byBehaviour[f] ?? 0) + 1;
  }

  return {
    flagCode,
    scope,
    gapMinutes,
    matchedVessels: vessels.length,
    totalRecordsScanned: records.length,
    byCategory,
    byBehaviour,
    darkEventCount: vessels.reduce((n, v) => n + v.behaviour.goingDark.length, 0),
    distanceNm: summarize(vessels.map((v) => v.distanceNm)),
    vessels,
  };
};

const num = (v, d = 1) => (v == null ? "n/a" : Number(v).toFixed(d));

export const formatFocusReport = (a) => {
  const lines = [];
  const add = (s = "") => lines.push(s);
  const target = a.flagCode ? `${a.flagCode}-flagged` : "all-flag";

  add(`# Deep dive: ${target} vessels of interest (AIS) — scope: ${a.scope}`);
  add();
  add("> **Methodology caveats — read first:**");
  for (const c of CAVEATS) add(`> - ${c}`);
  add();
  add("## Summary");
  add(`- Records scanned: ${a.totalRecordsScanned.toLocaleString()}`);
  add(`- Matched vessels: **${a.matchedVessels}**`);
  add(`- By classification: ${Object.entries(a.byCategory).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  add(`- By behaviour: ${Object.entries(a.byBehaviour).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  add(`- "Going dark" gap events (≥${a.gapMinutes} min): **${a.darkEventCount}**`);
  add(`- Distance in coverage (nm): median ${num(a.distanceNm.median)}, max ${num(a.distanceNm.max)}`);
  add();

  add("## Matched vessels");
  if (a.vessels.length === 0) {
    add("_None in this dataset._");
  } else {
    add("| MMSI | Name | Type | Class | Behaviour | Pts | Hrs | Dist (nm) | Max SOG |");
    add("| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |");
    for (const v of a.vessels) {
      add(`| ${v.mmsi} | ${v.name ?? ""} | ${v.type ?? ""} | ${v.category} | ${v.behaviourFlags.join(", ") || "—"} | ${v.points} | ${num(v.hoursInCoverage)} | ${num(v.distanceNm)} | ${num(v.maxSog)} |`);
    }
  }
  add();

  // Behavioural detail per vessel.
  const interesting = a.vessels.filter((v) => v.behaviourFlags.length > 0);
  if (interesting.length > 0) {
    add("## Behavioural detail");
    add("_Circumstantial signals — corroborate before concluding._");
    for (const v of interesting) {
      add(`### ${v.name ?? v.mmsi} (${v.mmsi}) — ${v.behaviourFlags.join(", ")}`);
      for (const e of v.behaviour.goingDark) {
        add(`- going dark: ${e.from} → ${e.to} (${e.minutes} min); last fix ${num(e.lastLat, 3)}, ${num(e.lastLon, 3)}`);
      }
      for (const e of v.behaviour.loitering) {
        add(`- loitering: ${e.from} → ${e.to} (${e.minutes} min) near ${num(e.centroidLat, 3)}, ${num(e.centroidLon, 3)}`);
      }
      for (const e of v.behaviour.nearInfrastructure) {
        add(`- near ${e.asset}: ${num(e.distanceNm, 2)} nm at ${e.timestamp}`);
      }
      if (v.behaviour.identity.names) {
        add(`- identity change — names: ${v.behaviour.identity.names.join(" / ")}`);
      }
      if (v.behaviour.identity.types) {
        add(`- identity change — types: ${v.behaviour.identity.types.join(" / ")}`);
      }
    }
  }

  return lines.join("\n");
};
