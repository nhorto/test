// Exploratory data analysis for AIS records (source-agnostic: works on records
// produced by either the DMA parser or the AISStream normalizer).
//
// Pure functions only — no I/O — so they are easy to unit test. The CLI in
// scripts/ais-eda.mjs wires these to a file/URL and prints a report.

// ---- small stats helpers -------------------------------------------------

const numeric = (values) =>
  values.filter((v) => v != null && !Number.isNaN(v)).sort((a, b) => a - b);

export const quantile = (sortedAsc, q) => {
  if (sortedAsc.length === 0) return null;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
};

export const summarize = (values) => {
  const s = numeric(values);
  if (s.length === 0) {
    return { count: 0, min: null, max: null, mean: null, median: null, p25: null, p75: null, p95: null };
  }
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    count: s.length,
    min: s[0],
    max: s[s.length - 1],
    mean: sum / s.length,
    median: quantile(s, 0.5),
    p25: quantile(s, 0.25),
    p75: quantile(s, 0.75),
    p95: quantile(s, 0.95),
  };
};

// Count occurrences of a key, returning [value, count] sorted by count desc.
export const valueCounts = (values, { top } = {}) => {
  const counts = new Map();
  for (const v of values) {
    const key = v == null ? "(none)" : String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return top ? sorted.slice(0, top) : sorted;
};

// Great-circle distance in nautical miles between two lat/lon points.
export const haversineNm = (aLat, aLon, bLat, bLon) => {
  const R = 3440.065; // Earth radius in nautical miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

// ---- main analysis -------------------------------------------------------

const FIELDS = [
  "mmsi", "timestamp", "lat", "lon", "sog", "cog", "heading",
  "vesselName", "imo", "callSign", "vesselType", "status", "draught",
];

// Build per-vessel summaries: point count, time span, distance, avg speed.
const perVesselStats = (recordsByMmsi) => {
  const vessels = [];
  for (const [mmsi, recs] of recordsByMmsi) {
    const ordered = [...recs].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    let distanceNm = 0;
    for (let i = 1; i < ordered.length; i += 1) {
      const p = ordered[i - 1];
      const c = ordered[i];
      if (p.lat != null && p.lon != null && c.lat != null && c.lon != null) {
        distanceNm += haversineNm(p.lat, p.lon, c.lat, c.lon);
      }
    }
    const startMs = Date.parse(ordered[0].timestamp);
    const endMs = Date.parse(ordered[ordered.length - 1].timestamp);
    const hours = (endMs - startMs) / 3.6e6;
    vessels.push({
      mmsi,
      name: ordered.find((r) => r.vesselName)?.vesselName ?? null,
      type: ordered.find((r) => r.vesselType)?.vesselType ?? null,
      points: ordered.length,
      spanHours: hours,
      distanceNm,
      avgSpeedKn: hours > 0 ? distanceNm / hours : null,
    });
  }
  return vessels;
};

export const computeEda = (records) => {
  const total = records.length;
  const byMmsi = new Map();
  const hourBuckets = new Map();
  const timestamps = [];

  for (const r of records) {
    if (r.mmsi != null) {
      if (!byMmsi.has(r.mmsi)) byMmsi.set(r.mmsi, []);
      byMmsi.get(r.mmsi).push(r);
    }
    if (r.timestamp) {
      const t = Date.parse(r.timestamp);
      if (!Number.isNaN(t)) {
        timestamps.push(t);
        const hour = new Date(t).toISOString().slice(0, 13); // YYYY-MM-DDTHH
        hourBuckets.set(hour, (hourBuckets.get(hour) ?? 0) + 1);
      }
    }
  }

  const completeness = {};
  for (const f of FIELDS) {
    const present = records.filter((r) => r[f] != null && r[f] !== "").length;
    completeness[f] = total > 0 ? present / total : 0;
  }

  const lats = records.map((r) => r.lat);
  const lons = records.map((r) => r.lon);
  const vessels = perVesselStats(byMmsi);

  const movingThreshold = 0.5; // knots
  const moving = records.filter((r) => (r.sog ?? 0) > movingThreshold).length;

  return {
    totalRecords: total,
    uniqueVessels: byMmsi.size,
    timeRange:
      timestamps.length > 0
        ? {
            start: new Date(Math.min(...timestamps)).toISOString(),
            end: new Date(Math.max(...timestamps)).toISOString(),
          }
        : null,
    boundingBox:
      numeric(lats).length > 0
        ? {
            minLat: Math.min(...numeric(lats)),
            maxLat: Math.max(...numeric(lats)),
            minLon: Math.min(...numeric(lons)),
            maxLon: Math.max(...numeric(lons)),
          }
        : null,
    sog: summarize(records.map((r) => r.sog)),
    draught: summarize(records.map((r) => r.draught)),
    pointsPerVessel: summarize(vessels.map((v) => v.points)),
    distanceNmPerVessel: summarize(vessels.map((v) => v.distanceNm)),
    movingShare: total > 0 ? moving / total : 0,
    byMobileType: valueCounts(records.map((r) => r.typeOfMobile), { top: 10 }),
    byShipType: valueCounts(records.map((r) => r.vesselType), { top: 15 }),
    byStatus: valueCounts(records.map((r) => r.status), { top: 15 }),
    recordsPerHour: [...hourBuckets.entries()].sort(),
    completeness,
    topVesselsByDistance: vessels
      .sort((a, b) => b.distanceNm - a.distanceNm)
      .slice(0, 10),
  };
};

// ---- report formatting ---------------------------------------------------

const num = (v, d = 2) => (v == null ? "n/a" : Number(v).toFixed(d));
const pct = (v) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);

export const formatEdaReport = (eda) => {
  const lines = [];
  const add = (s = "") => lines.push(s);

  add("# AIS Exploratory Data Analysis");
  add();
  add("## Overview");
  add(`- Records analyzed: **${eda.totalRecords.toLocaleString()}**`);
  add(`- Unique vessels (MMSI): **${eda.uniqueVessels.toLocaleString()}**`);
  if (eda.timeRange) add(`- Time range: ${eda.timeRange.start} → ${eda.timeRange.end}`);
  if (eda.boundingBox) {
    const b = eda.boundingBox;
    add(`- Bounding box: lat [${num(b.minLat, 3)}, ${num(b.maxLat, 3)}], lon [${num(b.minLon, 3)}, ${num(b.maxLon, 3)}]`);
  }
  add(`- Records with vessel moving (SOG > 0.5 kn): ${pct(eda.movingShare)}`);
  add();

  add("## Speed over ground (knots)");
  const s = eda.sog;
  add(`- min ${num(s.min)} · p25 ${num(s.p25)} · median ${num(s.median)} · mean ${num(s.mean)} · p75 ${num(s.p75)} · p95 ${num(s.p95)} · max ${num(s.max)}`);
  add();

  add("## Vessel activity");
  add(`- Points per vessel: median ${num(eda.pointsPerVessel.median, 0)}, max ${num(eda.pointsPerVessel.max, 0)}`);
  add(`- Distance per vessel (nm): median ${num(eda.distanceNmPerVessel.median)}, max ${num(eda.distanceNmPerVessel.max)}`);
  add();
  add("### Top vessels by distance travelled");
  add("| MMSI | Name | Type | Points | Distance (nm) | Avg speed (kn) |");
  add("| --- | --- | --- | ---: | ---: | ---: |");
  for (const v of eda.topVesselsByDistance) {
    add(`| ${v.mmsi} | ${v.name ?? ""} | ${v.type ?? ""} | ${v.points} | ${num(v.distanceNm)} | ${num(v.avgSpeedKn)} |`);
  }
  add();

  const table = (title, entries) => {
    add(`## ${title}`);
    for (const [key, count] of entries) add(`- ${key}: ${count.toLocaleString()}`);
    add();
  };
  table("By type of mobile", eda.byMobileType);
  table("By ship type", eda.byShipType);
  table("By navigational status", eda.byStatus);

  add("## Field completeness");
  for (const [field, frac] of Object.entries(eda.completeness)) {
    add(`- ${field}: ${pct(frac)}`);
  }
  add();

  add("## Records per hour");
  for (const [hour, count] of eda.recordsPerHour) {
    add(`- ${hour}:00 — ${count.toLocaleString()}`);
  }

  return lines.join("\n");
};
