// Behavioural anomaly detection for AIS tracks. Pure functions, no I/O.
//
// These heuristics surface *patterns of interest* independent of the declared
// ship type — useful because naval/intelligence vessels often squawk as
// civilian (or not at all). Every signal is circumstantial: corroborate before
// drawing conclusions.
//
// Signals:
//   going_dark         – a reporting gap >= gapMinutes (AIS possibly switched off)
//   loitering          – an extended low-speed dwell while "under way"
//   near_infrastructure– a fix within infraRadiusNm of a supplied asset (cable
//                        landing, pipeline, wind farm, etc.)
//   identity_change    – the same MMSI broadcasting >1 name or >1 ship type
//                        (possible spoofing)

import { haversineNm } from "./eda.mjs";

const MOORED_OR_ANCHORED = /moor|anchor/i;

const sortByTime = (recs) =>
  [...recs].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

// Reporting gaps >= threshold.
export const detectGoingDark = (recs, { gapMinutes = 30 } = {}) => {
  const ordered = sortByTime(recs);
  const events = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    const minutes = (Date.parse(cur.timestamp) - Date.parse(prev.timestamp)) / 6e4;
    if (minutes >= gapMinutes) {
      events.push({
        from: prev.timestamp,
        to: cur.timestamp,
        minutes: Math.round(minutes),
        lastLat: prev.lat,
        lastLon: prev.lon,
      });
    }
  }
  return events;
};

// Contiguous low-speed runs lasting >= loiterMinutes, excluding moored/anchored
// fixes (normal port behaviour).
export const detectLoitering = (
  recs,
  { loiterSpeed = 1, loiterMinutes = 60 } = {},
) => {
  const ordered = sortByTime(recs).filter(
    (r) => r.sog != null && !(r.status && MOORED_OR_ANCHORED.test(r.status)),
  );
  const events = [];
  let run = [];

  const flush = () => {
    if (run.length >= 2) {
      const minutes =
        (Date.parse(run[run.length - 1].timestamp) - Date.parse(run[0].timestamp)) / 6e4;
      if (minutes >= loiterMinutes) {
        const lat = run.reduce((s, r) => s + r.lat, 0) / run.length;
        const lon = run.reduce((s, r) => s + r.lon, 0) / run.length;
        events.push({
          from: run[0].timestamp,
          to: run[run.length - 1].timestamp,
          minutes: Math.round(minutes),
          centroidLat: lat,
          centroidLon: lon,
          fixes: run.length,
        });
      }
    }
    run = [];
  };

  for (const r of ordered) {
    if (r.sog <= loiterSpeed && r.lat != null && r.lon != null) run.push(r);
    else flush();
  }
  flush();
  return events;
};

// Fixes within infraRadiusNm of any supplied infrastructure point
// ({ lat, lon, name }). Returns the closest approach per asset.
export const detectNearInfrastructure = (
  recs,
  { infrastructure = [], infraRadiusNm = 2 } = {},
) => {
  if (infrastructure.length === 0) return [];
  const hits = new Map(); // asset name -> closest approach
  for (const r of recs) {
    if (r.lat == null || r.lon == null) continue;
    for (const asset of infrastructure) {
      const nm = haversineNm(r.lat, r.lon, asset.lat, asset.lon);
      if (nm <= infraRadiusNm) {
        const key = asset.name ?? `${asset.lat},${asset.lon}`;
        const prev = hits.get(key);
        if (!prev || nm < prev.distanceNm) {
          hits.set(key, { asset: key, distanceNm: nm, timestamp: r.timestamp });
        }
      }
    }
  }
  return [...hits.values()];
};

// Same MMSI broadcasting more than one name or ship type.
export const detectIdentityChange = (recs) => {
  const names = new Set(recs.map((r) => r.vesselName).filter(Boolean));
  const types = new Set(recs.map((r) => r.vesselType).filter(Boolean));
  const result = {};
  if (names.size > 1) result.names = [...names];
  if (types.size > 1) result.types = [...types];
  return result;
};

// Combine all detectors into one result for a single vessel's records.
export const detectBehaviour = (recs, opts = {}) => {
  const goingDark = detectGoingDark(recs, opts);
  const loitering = detectLoitering(recs, opts);
  const nearInfrastructure = detectNearInfrastructure(recs, opts);
  const identity = detectIdentityChange(recs);

  const flags = [];
  if (goingDark.length) flags.push("going_dark");
  if (loitering.length) flags.push("loitering");
  if (nearInfrastructure.length) flags.push("near_infrastructure");
  if (identity.names || identity.types) flags.push("identity_change");

  return { flags, goingDark, loitering, nearInfrastructure, identity };
};
