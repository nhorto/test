import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { toAisRecord, isValidAisRecord, parseAisCsv } from "../parseAis.mjs";

const fixture = readFileSync(
  fileURLToPath(new URL("../__fixtures__/sample_ais.csv", import.meta.url)),
  "utf8",
);

test("coerces types and normalizes UTC timestamps", () => {
  const record = toAisRecord({
    MMSI: "367000010",
    BaseDateTime: "2023-01-01T00:00:02",
    LAT: "40.6892",
    LON: "-74.0445",
    SOG: "12.3",
    VesselType: "60",
    VesselName: "  FERRY  ",
    IMO: "",
  });

  assert.equal(record.mmsi, "367000010");
  assert.equal(record.timestamp, "2023-01-01T00:00:02.000Z");
  assert.equal(record.lat, 40.6892);
  assert.equal(record.sog, 12.3);
  assert.equal(record.vesselType, 60);
  assert.equal(record.vesselName, "FERRY");
  assert.equal(record.imo, null, "blank fields become null");
});

test("rejects records without a valid position", () => {
  assert.equal(
    isValidAisRecord(toAisRecord({ MMSI: "1", BaseDateTime: "2023-01-01T00:00:00" })),
    false,
  );
  assert.equal(
    isValidAisRecord(
      toAisRecord({ MMSI: "1", BaseDateTime: "2023-01-01T00:00:00", LAT: "200", LON: "0" }),
    ),
    false,
    "out-of-range latitude is invalid",
  );
});

test("parseAisCsv drops invalid rows by default", () => {
  const records = parseAisCsv(fixture);
  assert.equal(records.length, 5, "the malformed/no-position row is dropped");
  assert.ok(records.every(isValidAisRecord));
});

test("parseAisCsv can keep invalid rows when asked", () => {
  const records = parseAisCsv(fixture, { dropInvalid: false });
  assert.equal(records.length, 6);
});
