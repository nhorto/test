// Aggregate AIS position records into per-vessel tracks and filter them.

// Group records by MMSI, ordering each vessel's points by time. The most recent
// non-null vessel metadata (name, IMO, type) is surfaced on the track.
export const buildTracks = (records) => {
  const byMmsi = new Map();

  for (const record of records) {
    if (record.mmsi == null) {
      continue;
    }
    if (!byMmsi.has(record.mmsi)) {
      byMmsi.set(record.mmsi, []);
    }
    byMmsi.get(record.mmsi).push(record);
  }

  const tracks = [];
  for (const [mmsi, points] of byMmsi) {
    points.sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return ta - tb;
    });

    const latest = [...points].reverse();
    const pick = (key) => latest.find((p) => p[key] != null)?.[key] ?? null;

    tracks.push({
      mmsi,
      vesselName: pick("vesselName"),
      imo: pick("imo"),
      vesselType: pick("vesselType"),
      start: points[0]?.timestamp ?? null,
      end: points[points.length - 1]?.timestamp ?? null,
      points: points.map((p) => ({
        timestamp: p.timestamp,
        lat: p.lat,
        lon: p.lon,
        sog: p.sog,
        cog: p.cog,
        heading: p.heading,
        status: p.status,
      })),
    });
  }

  return tracks;
};

// Keep only records inside a bounding box. `box` is
// { minLat, maxLat, minLon, maxLon } (inclusive).
export const filterByBoundingBox = (records, box) => {
  const { minLat, maxLat, minLon, maxLon } = box;
  return records.filter(
    (r) =>
      r.lat != null &&
      r.lon != null &&
      r.lat >= minLat &&
      r.lat <= maxLat &&
      r.lon >= minLon &&
      r.lon <= maxLon,
  );
};

// Keep only records whose timestamp falls within [start, end] (inclusive).
// `start`/`end` may be Date objects or ISO strings; either may be omitted.
export const filterByTimeRange = (records, { start, end } = {}) => {
  const startMs = start != null ? new Date(start).getTime() : -Infinity;
  const endMs = end != null ? new Date(end).getTime() : Infinity;
  return records.filter((r) => {
    if (r.timestamp == null) {
      return false;
    }
    const t = Date.parse(r.timestamp);
    return t >= startMs && t <= endMs;
  });
};
