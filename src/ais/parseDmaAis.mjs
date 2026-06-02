// Map raw Danish Maritime Authority (DMA) AIS CSV rows into typed records.
//
// DMA "aisdk" CSV columns (comma-separated):
//   Timestamp, Type of mobile, MMSI, Latitude, Longitude, Navigational status,
//   ROT, SOG, COG, Heading, IMO, Callsign, Name, Ship type, Cargo type, Width,
//   Length, Type of position fixing device, Draught, Destination, ETA,
//   Data source type, A, B, C, D
//
// The output record shape matches the AISStream normalizer so both sources can
// feed the same track-building code.

import { parseCsvObjects } from "./parseCsv.mjs";

// DMA encodes "no value" as empty, "Unknown", or "Undefined" in various fields.
const UNKNOWNS = new Set(["", "unknown", "undefined", "n/a"]);

const toText = (value) => {
  const trimmed = (value ?? "").trim();
  return UNKNOWNS.has(trimmed.toLowerCase()) ? null : trimmed;
};

const toNumber = (value) => {
  const text = toText(value);
  if (text == null) {
    return null;
  }
  const num = Number(text);
  return Number.isNaN(num) ? null : num;
};

// DMA timestamps look like "01/01/2023 00:00:00" (dd/mm/yyyy hh:mm:ss), in UTC.
export const parseDmaTimestamp = (value) => {
  const text = toText(value);
  if (!text) {
    return null;
  }
  const match = text.match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!match) {
    // Fall back to native parsing for any ISO-ish variants.
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const [, dd, mm, yyyy, hh, min, ss] = match;
  const ms = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +min, +ss);
  return new Date(ms).toISOString();
};

// Read a column allowing for the optional "# " prefix DMA sometimes puts on the
// first header (e.g. "# Timestamp").
const field = (raw, name) => raw[name] ?? raw[`# ${name}`];

// Convert one raw record (string-keyed) into a typed AIS record.
export const toDmaRecord = (raw) => ({
  mmsi: toText(field(raw, "MMSI")),
  timestamp: parseDmaTimestamp(field(raw, "Timestamp")),
  lat: toNumber(raw.Latitude),
  lon: toNumber(raw.Longitude),
  sog: toNumber(raw.SOG), // speed over ground (knots)
  cog: toNumber(raw.COG), // course over ground (degrees)
  heading: toNumber(raw.Heading),
  rot: toNumber(raw.ROT), // rate of turn
  vesselName: toText(raw.Name),
  imo: toText(raw.IMO),
  callSign: toText(raw.Callsign),
  vesselType: toText(raw["Ship type"]), // e.g. "Cargo", "Tanker", "Passenger"
  typeOfMobile: toText(raw["Type of mobile"]), // e.g. "Class A", "Class B"
  status: toText(raw["Navigational status"]),
  length: toNumber(raw.Length),
  width: toNumber(raw.Width),
  draught: toNumber(raw.Draught),
  destination: toText(raw.Destination),
});

// A record is usable only if it has an MMSI, a timestamp, and a valid position.
// DMA uses 91.0 / 181.0 as "position unavailable" sentinels, which fall outside
// the valid lat/lon ranges and are rejected here.
export const isValidDmaRecord = (record) =>
  record.mmsi != null &&
  record.timestamp != null &&
  record.lat != null &&
  record.lon != null &&
  record.lat >= -90 &&
  record.lat <= 90 &&
  record.lon >= -180 &&
  record.lon <= 180;

// Parse a full DMA AIS CSV string into validated records.
export const parseDmaCsv = (text, { dropInvalid = true } = {}) => {
  const records = parseCsvObjects(text).map(toDmaRecord);
  return dropInvalid ? records.filter(isValidDmaRecord) : records;
};
