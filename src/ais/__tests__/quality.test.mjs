import test from "node:test";
import assert from "node:assert/strict";

import { isValidMmsi, auditQuality, formatQualityReport } from "../quality.mjs";

test("isValidMmsi requires exactly 9 digits", () => {
  assert.equal(isValidMmsi("219000001"), true);
  assert.equal(isValidMmsi("12345"), false);
  assert.equal(isValidMmsi("1234567890"), false);
  assert.equal(isValidMmsi("21900000a"), false);
  assert.equal(isValidMmsi(219000001), false);
});

test("auditQuality flags bad MMSI, sentinel/implausible speed, jumps, dupes", () => {
  const records = [
    // valid moving vessel
    { mmsi: "219000001", timestamp: "2023-01-01T00:00:00Z", lat: 55.0, lon: 12.0, sog: 10 },
    { mmsi: "219000001", timestamp: "2023-01-01T00:05:00Z", lat: 55.01, lon: 12.0, sog: 10 },
    // teleport: ~600 nm in 5 min => huge implied speed
    { mmsi: "219000001", timestamp: "2023-01-01T00:10:00Z", lat: 65.0, lon: 12.0, sog: 10 },
    // duplicate (mmsi, timestamp)
    { mmsi: "219000001", timestamp: "2023-01-01T00:10:00Z", lat: 65.0, lon: 12.0, sog: 10 },
    // sentinel speed
    { mmsi: "265000002", timestamp: "2023-01-01T00:00:00Z", lat: 57.0, lon: 11.0, sog: 102.3 },
    // implausible speed
    { mmsi: "265000002", timestamp: "2023-01-01T00:05:00Z", lat: 57.0, lon: 11.0, sog: 95 },
    // invalid MMSI
    { mmsi: "12345", timestamp: "2023-01-01T00:00:00Z", lat: 56.0, lon: 10.0, sog: 1 },
  ];

  const audit = auditQuality(records);
  assert.equal(audit.invalidMmsiCount, 1);
  assert.deepEqual(audit.invalidMmsiExamples, ["12345"]);
  assert.equal(audit.sentinelSpeed, 1);
  assert.equal(audit.implausibleSpeed, 1);
  assert.equal(audit.positionJumps, 1);
  assert.equal(audit.duplicates, 1);
  assert.ok(audit.reportingGapMinutes.median >= 0);
});

test("formatQualityReport renders a markdown section", () => {
  const report = formatQualityReport(auditQuality([]));
  assert.match(report, /## Data quality audit/);
  assert.match(report, /Invalid MMSIs/);
});
