import test from "node:test";
import assert from "node:assert/strict";

import { analyzeFocus, formatFocusReport, CAVEATS } from "../deepDive.mjs";

// A mixed dataset: a Russian military vessel (with a reporting gap), a Russian
// cargo vessel, and a Danish vessel.
const records = [
  // Russian "military" vessel transiting, with a 45-min AIS gap mid-track.
  { mmsi: "273456789", timestamp: "2023-01-01T00:00:00Z", lat: 55.0, lon: 11.0, sog: 14, vesselName: "RFS GROZNY", vesselType: "Military" },
  { mmsi: "273456789", timestamp: "2023-01-01T00:10:00Z", lat: 55.1, lon: 11.2, sog: 14, vesselName: "RFS GROZNY", vesselType: "Military" },
  // 45-minute gap here (possible "going dark"):
  { mmsi: "273456789", timestamp: "2023-01-01T00:55:00Z", lat: 55.4, lon: 11.8, sog: 16, vesselName: "RFS GROZNY", vesselType: "Military" },
  // Russian cargo vessel.
  { mmsi: "273111222", timestamp: "2023-01-01T00:00:00Z", lat: 54.9, lon: 10.5, sog: 11, vesselName: "VOLGA STAR", vesselType: "Cargo" },
  { mmsi: "273111222", timestamp: "2023-01-01T00:10:00Z", lat: 54.95, lon: 10.6, sog: 11, vesselName: "VOLGA STAR", vesselType: "Cargo" },
  // Danish vessel (should be excluded from the RU focus).
  { mmsi: "219000001", timestamp: "2023-01-01T00:00:00Z", lat: 55.7, lon: 12.5, sog: 8, vesselName: "DANA", vesselType: "Cargo" },
];

test("focuses on the target flag", () => {
  const a = analyzeFocus(records, { flagCode: "RU" });
  assert.equal(a.matchedVessels, 2, "two Russian-flagged vessels");
  assert.ok(a.vessels.every((v) => v.flag === "Russia"));
  assert.equal(a.byCategory.military, 1);
  assert.equal(a.byCategory.other, 1);
});

test("militaryOnly narrows to military-classified vessels", () => {
  const a = analyzeFocus(records, { flagCode: "RU", militaryOnly: true });
  assert.equal(a.matchedVessels, 1);
  assert.equal(a.vessels[0].name, "RFS GROZNY");
});

test("detects 'going dark' reporting gaps", () => {
  const a = analyzeFocus(records, { flagCode: "RU", gapMinutes: 30 });
  assert.equal(a.darkEventCount, 1);
  const grozny = a.vessels.find((v) => v.mmsi === "273456789");
  assert.equal(grozny.darkEvents.length, 1);
  assert.equal(grozny.darkEvents[0].minutes, 45);
});

test("a higher gap threshold suppresses the event", () => {
  const a = analyzeFocus(records, { flagCode: "RU", gapMinutes: 60 });
  assert.equal(a.darkEventCount, 0);
});

test("watchlist can flag an otherwise-unclassified vessel as military", () => {
  const a = analyzeFocus(records, {
    flagCode: "RU",
    militaryOnly: true,
    watchlist: { names: ["Volga Star"] },
  });
  const names = a.vessels.map((v) => v.name).sort();
  assert.deepEqual(names, ["RFS GROZNY", "VOLGA STAR"]);
});

test("report renders caveats and the vessel table", () => {
  const report = formatFocusReport(analyzeFocus(records, { flagCode: "RU" }));
  assert.match(report, /Deep dive: RU-flagged/);
  assert.match(report, /Methodology caveats/);
  assert.match(report, /RFS GROZNY/);
  for (const c of CAVEATS) assert.ok(report.includes(c));
});
