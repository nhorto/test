// Data-quality audit for AIS records. Pure functions, no I/O.
//
// Surfaces the common AIS pitfalls: malformed MMSIs, impossible speeds,
// teleporting positions, duplicate reports, and reporting gaps.

import { haversineNm, summarize } from "./eda.mjs";

// A valid AIS MMSI is exactly 9 digits.
export const isValidMmsi = (mmsi) => typeof mmsi === "string" && /^\d{9}$/.test(mmsi);

// AIS encodes "speed not available" as 102.3 kn; anything above ~80 kn is
// implausible for a real vessel.
const SOG_SENTINEL = 102.3;
const MAX_PLAUSIBLE_SOG = 80; // knots
// Implied speed (from position deltas) above this flags a position jump.
const MAX_IMPLIED_SPEED = 100; // knots

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

export const auditQuality = (records) => {
  const total = records.length;
  const byMmsi = groupByMmsi(records);

  // --- MMSI validity ---
  const invalidMmsi = new Set();
  for (const mmsi of byMmsi.keys()) {
    if (!isValidMmsi(mmsi)) invalidMmsi.add(mmsi);
  }

  // --- implausible / sentinel speeds ---
  let sentinelSpeed = 0;
  let implausibleSpeed = 0;
  for (const r of records) {
    if (r.sog == null) continue;
    if (Math.abs(r.sog - SOG_SENTINEL) < 0.05) sentinelSpeed += 1;
    else if (r.sog > MAX_PLAUSIBLE_SOG) implausibleSpeed += 1;
  }

  // --- position jumps & reporting gaps (per vessel) ---
  const gapMinutes = [];
  let positionJumps = 0;
  for (const recs of byMmsi.values()) {
    for (let i = 1; i < recs.length; i += 1) {
      const prev = recs[i - 1];
      const cur = recs[i];
      const dtHours = (Date.parse(cur.timestamp) - Date.parse(prev.timestamp)) / 3.6e6;
      if (dtHours > 0) {
        gapMinutes.push(dtHours * 60);
        if (
          prev.lat != null && prev.lon != null &&
          cur.lat != null && cur.lon != null
        ) {
          const nm = haversineNm(prev.lat, prev.lon, cur.lat, cur.lon);
          if (nm / dtHours > MAX_IMPLIED_SPEED) positionJumps += 1;
        }
      }
    }
  }

  // --- duplicate (mmsi, timestamp) reports ---
  const seen = new Set();
  let duplicates = 0;
  for (const r of records) {
    const key = `${r.mmsi}|${r.timestamp}`;
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }

  const share = (n) => (total > 0 ? n / total : 0);
  return {
    totalRecords: total,
    invalidMmsiCount: invalidMmsi.size,
    invalidMmsiExamples: [...invalidMmsi].slice(0, 5),
    sentinelSpeed,
    sentinelSpeedShare: share(sentinelSpeed),
    implausibleSpeed,
    implausibleSpeedShare: share(implausibleSpeed),
    positionJumps,
    duplicates,
    duplicateShare: share(duplicates),
    reportingGapMinutes: summarize(gapMinutes),
  };
};

const pct = (v) => `${(v * 100).toFixed(2)}%`;
const num = (v, d = 1) => (v == null ? "n/a" : Number(v).toFixed(d));

export const formatQualityReport = (audit) => {
  const g = audit.reportingGapMinutes;
  const lines = [
    "## Data quality audit",
    `- Invalid MMSIs (not 9 digits): **${audit.invalidMmsiCount}**` +
      (audit.invalidMmsiExamples.length ? ` (e.g. ${audit.invalidMmsiExamples.join(", ")})` : ""),
    `- "Speed not available" sentinels (102.3 kn): ${audit.sentinelSpeed} (${pct(audit.sentinelSpeedShare)})`,
    `- Implausible speeds (>80 kn): ${audit.implausibleSpeed} (${pct(audit.implausibleSpeedShare)})`,
    `- Position jumps (implied >100 kn between fixes): ${audit.positionJumps}`,
    `- Duplicate (MMSI, timestamp) reports: ${audit.duplicates} (${pct(audit.duplicateShare)})`,
    `- Reporting gap between fixes (min): median ${num(g.median)}, p95 ${num(g.p95)}, max ${num(g.max)}`,
  ];
  return lines.join("\n");
};
