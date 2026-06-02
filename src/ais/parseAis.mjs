// Map raw NOAA AIS CSV rows into typed AIS position records.
//
// Modern NOAA AIS CSV columns (2015+):
//   MMSI, BaseDateTime, LAT, LON, SOG, COG, Heading, VesselName, IMO,
//   CallSign, VesselType, Status, Length, Width, Draft, Cargo, TransceiverClass

import { parseCsvObjects } from "./parseCsv.mjs";

const toNumber = (value) => {
  if (value == null || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
};

const toText = (value) => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

// NOAA timestamps look like "2023-01-01T00:00:02". They are UTC but lack a
// timezone suffix, so append "Z" before parsing.
const toIso = (value) => {
  const text = toText(value);
  if (!text) {
    return null;
  }
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// Convert one raw record (string-keyed) into a typed AIS record.
export const toAisRecord = (raw) => ({
  mmsi: toText(raw.MMSI),
  timestamp: toIso(raw.BaseDateTime),
  lat: toNumber(raw.LAT),
  lon: toNumber(raw.LON),
  sog: toNumber(raw.SOG), // speed over ground (knots)
  cog: toNumber(raw.COG), // course over ground (degrees)
  heading: toNumber(raw.Heading),
  vesselName: toText(raw.VesselName),
  imo: toText(raw.IMO),
  callSign: toText(raw.CallSign),
  vesselType: toNumber(raw.VesselType),
  status: toText(raw.Status),
  length: toNumber(raw.Length),
  width: toNumber(raw.Width),
  draft: toNumber(raw.Draft),
  cargo: toNumber(raw.Cargo),
  transceiverClass: toText(raw.TransceiverClass),
});

// A record is usable only if it has an MMSI, a timestamp, and a valid position.
export const isValidAisRecord = (record) =>
  record.mmsi != null &&
  record.timestamp != null &&
  record.lat != null &&
  record.lon != null &&
  record.lat >= -90 &&
  record.lat <= 90 &&
  record.lon >= -180 &&
  record.lon <= 180;

// Parse a full AIS CSV string into validated records.
export const parseAisCsv = (text, { dropInvalid = true } = {}) => {
  const records = parseCsvObjects(text).map(toAisRecord);
  return dropInvalid ? records.filter(isValidAisRecord) : records;
};
