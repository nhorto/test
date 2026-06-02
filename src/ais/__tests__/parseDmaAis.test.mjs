import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  toDmaRecord,
  isValidDmaRecord,
  parseDmaCsv,
  parseDmaTimestamp,
} from "../parseDmaAis.mjs";

const fixture = readFileSync(
  fileURLToPath(new URL("../__fixtures__/sample_aisdk.csv", import.meta.url)),
  "utf8",
);

test("parses dd/mm/yyyy hh:mm:ss timestamps as UTC", () => {
  assert.equal(
    parseDmaTimestamp("01/02/2023 03:04:05"),
    "2023-02-01T03:04:05.000Z",
  );
  assert.equal(parseDmaTimestamp(""), null);
  assert.equal(parseDmaTimestamp("garbage"), null);
});

test("coerces types and treats Unknown/Undefined as null", () => {
  const record = toDmaRecord({
    Timestamp: "01/01/2023 00:00:00",
    "Type of mobile": "Class A",
    MMSI: "219000001",
    Latitude: "55.6761",
    Longitude: "12.5683",
    "Navigational status": "Under way using engine",
    SOG: "12.3",
    Heading: "99",
    IMO: "Unknown",
    Name: "  MAERSK ALPHA ",
    "Ship type": "Cargo",
    Draught: "12.5",
  });

  assert.equal(record.mmsi, "219000001");
  assert.equal(record.timestamp, "2023-01-01T00:00:00.000Z");
  assert.equal(record.lat, 55.6761);
  assert.equal(record.sog, 12.3);
  assert.equal(record.vesselName, "MAERSK ALPHA");
  assert.equal(record.vesselType, "Cargo");
  assert.equal(record.draught, 12.5);
  assert.equal(record.imo, null, '"Unknown" becomes null');
});

test("handles the optional '# Timestamp' header prefix", () => {
  const record = toDmaRecord({
    "# Timestamp": "01/01/2023 00:00:00",
    MMSI: "219000001",
    Latitude: "55.6",
    Longitude: "12.5",
  });
  assert.equal(record.timestamp, "2023-01-01T00:00:00.000Z");
});

test("rejects 91/181 position sentinels", () => {
  const record = toDmaRecord({
    Timestamp: "01/01/2023 00:00:00",
    MMSI: "1",
    Latitude: "91.0",
    Longitude: "181.0",
  });
  assert.equal(isValidDmaRecord(record), false);
});

test("parseDmaCsv drops invalid rows by default", () => {
  const records = parseDmaCsv(fixture);
  assert.equal(records.length, 5, "the 91/181 sentinel row is dropped");
  assert.ok(records.every(isValidDmaRecord));
});

test("parseDmaCsv can keep invalid rows when asked", () => {
  assert.equal(parseDmaCsv(fixture, { dropInvalid: false }).length, 6);
});
