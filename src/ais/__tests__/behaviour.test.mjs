import test from "node:test";
import assert from "node:assert/strict";

import {
  detectGoingDark,
  detectLoitering,
  detectNearInfrastructure,
  detectIdentityChange,
  detectBehaviour,
} from "../behaviour.mjs";

const ts = (min) => new Date(Date.UTC(2023, 0, 1, 0, min, 0)).toISOString();

test("detectGoingDark flags gaps at/over the threshold", () => {
  const recs = [
    { timestamp: ts(0), lat: 55, lon: 11, sog: 10 },
    { timestamp: ts(10), lat: 55.1, lon: 11.1, sog: 10 },
    { timestamp: ts(55), lat: 55.4, lon: 11.8, sog: 12 }, // 45-min gap
  ];
  const events = detectGoingDark(recs, { gapMinutes: 30 });
  assert.equal(events.length, 1);
  assert.equal(events[0].minutes, 45);
  assert.equal(detectGoingDark(recs, { gapMinutes: 60 }).length, 0);
});

test("detectLoitering flags long low-speed dwell, ignoring moored fixes", () => {
  const recs = [
    { timestamp: ts(0), lat: 55, lon: 11, sog: 0.2, status: "Under way using engine" },
    { timestamp: ts(90), lat: 55.001, lon: 11.001, sog: 0.1, status: "Under way using engine" },
  ];
  assert.equal(detectLoitering(recs, { loiterMinutes: 60 }).length, 1);

  const moored = recs.map((r) => ({ ...r, status: "Moored" }));
  assert.equal(detectLoitering(moored, { loiterMinutes: 60 }).length, 0);
});

test("detectNearInfrastructure reports closest approach within radius", () => {
  const recs = [
    { timestamp: ts(0), lat: 55.0, lon: 11.0 },
    { timestamp: ts(5), lat: 55.105, lon: 11.2 }, // ~near the asset
  ];
  const infra = [{ lat: 55.1, lon: 11.2, name: "Cable X" }];
  const hits = detectNearInfrastructure(recs, { infrastructure: infra, infraRadiusNm: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].asset, "Cable X");
  assert.ok(hits[0].distanceNm <= 1);
});

test("detectIdentityChange spots multiple names or types per MMSI", () => {
  const recs = [
    { vesselName: "ALPHA", vesselType: "Cargo" },
    { vesselName: "BRAVO", vesselType: "Cargo" },
  ];
  const result = detectIdentityChange(recs);
  assert.deepEqual(result.names.sort(), ["ALPHA", "BRAVO"]);
  assert.equal(result.types, undefined);
});

test("detectBehaviour aggregates flags", () => {
  const recs = [
    { timestamp: ts(0), lat: 55, lon: 11, sog: 0.1, vesselName: "ALPHA", status: "Under way using engine" },
    { timestamp: ts(90), lat: 55.001, lon: 11.001, sog: 0.1, vesselName: "BRAVO", status: "Under way using engine" },
  ];
  const b = detectBehaviour(recs, { loiterMinutes: 60, gapMinutes: 30 });
  assert.ok(b.flags.includes("loitering"));
  assert.ok(b.flags.includes("going_dark")); // 90-min gap between the two fixes
  assert.ok(b.flags.includes("identity_change"));
});
