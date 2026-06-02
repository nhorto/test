import test from "node:test";
import assert from "node:assert/strict";

import { analyzeFocus, formatFocusReport, CAVEATS } from "../deepDive.mjs";

// A mixed dataset: a Russian military vessel (with a reporting gap), a Russian
// cargo vessel (ordinary behaviour), and a Danish vessel.
const records = [
  // Russian "military" vessel transiting, with a 45-min AIS gap mid-track.
  { mmsi: "273456789", timestamp: "2023-01-01T00:00:00Z", lat: 55.0, lon: 11.0, sog: 14, vesselName: "RFS GROZNY", vesselType: "Military" },
  { mmsi: "273456789", timestamp: "2023-01-01T00:10:00Z", lat: 55.1, lon: 11.2, sog: 14, vesselName: "RFS GROZNY", vesselType: "Military" },
  // 45-minute gap here (possible "going dark"):
  { mmsi: "273456789", timestamp: "2023-01-01T00:55:00Z", lat: 55.4, lon: 11.8, sog: 16, vesselName: "RFS GROZNY", vesselType: "Military" },
  // Russian cargo vessel, ordinary transit (no behavioural flags).
  { mmsi: "273111222", timestamp: "2023-01-01T00:00:00Z", lat: 54.9, lon: 10.5, sog: 11, vesselName: "VOLGA STAR", vesselType: "Cargo" },
  { mmsi: "273111222", timestamp: "2023-01-01T00:10:00Z", lat: 54.95, lon: 10.6, sog: 11, vesselName: "VOLGA STAR", vesselType: "Cargo" },
  // Danish vessel (excluded from the RU focus).
  { mmsi: "219000001", timestamp: "2023-01-01T00:00:00Z", lat: 55.7, lon: 12.5, sog: 8, vesselName: "DANA", vesselType: "Cargo" },
];

test("scope 'all' returns every Russian-flagged vessel", () => {
  const a = analyzeFocus(records, { flagCode: "RU", scope: "all" });
  assert.equal(a.matchedVessels, 2);
  assert.ok(a.vessels.every((v) => v.flag === "Russia"));
});

test("default scope 'interest' keeps military + behavioural, drops plain cargo", () => {
  const a = analyzeFocus(records, { flagCode: "RU" });
  assert.equal(a.matchedVessels, 1, "only the military/going-dark vessel");
  assert.equal(a.vessels[0].name, "RFS GROZNY");
  assert.equal(a.byCategory.military, 1);
});

test("scope 'military' narrows to military-classified vessels", () => {
  const a = analyzeFocus(records, { flagCode: "RU", scope: "military" });
  assert.equal(a.matchedVessels, 1);
  assert.equal(a.vessels[0].name, "RFS GROZNY");
});

test("a behavioural flag pulls an otherwise-civilian vessel into 'interest'", () => {
  // Make the cargo vessel loiter (long low-speed dwell) -> should now match.
  const loitering = [
    { mmsi: "273111222", timestamp: "2023-01-01T00:00:00Z", lat: 55.0, lon: 11.0, sog: 0.2, vesselName: "VOLGA STAR", vesselType: "Cargo", status: "Under way using engine" },
    { mmsi: "273111222", timestamp: "2023-01-01T01:30:00Z", lat: 55.001, lon: 11.001, sog: 0.1, vesselName: "VOLGA STAR", vesselType: "Cargo", status: "Under way using engine" },
  ];
  const a = analyzeFocus(loitering, { flagCode: "RU", loiterMinutes: 60 });
  assert.equal(a.matchedVessels, 1);
  assert.ok(a.vessels[0].behaviourFlags.includes("loitering"));
});

test("detects 'going dark' reporting gaps", () => {
  const a = analyzeFocus(records, { flagCode: "RU", gapMinutes: 30 });
  assert.equal(a.darkEventCount, 1);
  const grozny = a.vessels.find((v) => v.mmsi === "273456789");
  assert.equal(grozny.behaviour.goingDark.length, 1);
  assert.equal(grozny.behaviour.goingDark[0].minutes, 45);
});

test("near-infrastructure proximity is flagged when assets are supplied", () => {
  const a = analyzeFocus(records, {
    flagCode: "RU",
    infrastructure: [{ lat: 55.1, lon: 11.2, name: "Baltic Pipe" }],
    infraRadiusNm: 1,
  });
  const grozny = a.vessels.find((v) => v.mmsi === "273456789");
  assert.ok(grozny.behaviourFlags.includes("near_infrastructure"));
  assert.equal(grozny.behaviour.nearInfrastructure[0].asset, "Baltic Pipe");
});

test("report renders caveats, scope and the vessel table", () => {
  const report = formatFocusReport(analyzeFocus(records, { flagCode: "RU" }));
  assert.match(report, /Deep dive: RU-flagged/);
  assert.match(report, /scope: interest/);
  assert.match(report, /Methodology caveats/);
  assert.match(report, /RFS GROZNY/);
  for (const c of CAVEATS) assert.ok(report.includes(c));
});
