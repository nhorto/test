import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseDmaCsv } from "../parseDmaAis.mjs";
import {
  buildTracks,
  filterByBoundingBox,
  filterByTimeRange,
} from "../tracks.mjs";

const fixture = readFileSync(
  fileURLToPath(new URL("../__fixtures__/sample_aisdk.csv", import.meta.url)),
  "utf8",
);
const records = parseDmaCsv(fixture);

test("groups records into per-vessel tracks ordered by time", () => {
  const tracks = buildTracks(records);
  assert.equal(tracks.length, 2);

  const maersk = tracks.find((t) => t.mmsi === "219000001");
  assert.equal(maersk.points.length, 3);
  assert.equal(maersk.vesselName, "MAERSK ALPHA");
  assert.equal(maersk.vesselType, "Cargo");
  assert.equal(maersk.start, "2023-01-01T00:00:00.000Z");
  assert.equal(maersk.end, "2023-01-01T00:10:00.000Z");

  const times = maersk.points.map((p) => p.timestamp);
  assert.deepEqual(times, [...times].sort());
});

test("buildTracks sorts out-of-order input", () => {
  const maersk = records.filter((r) => r.mmsi === "219000001");
  const shuffled = [maersk[2], maersk[0], maersk[1]];
  const [track] = buildTracks(shuffled);
  assert.equal(track.points[0].timestamp, "2023-01-01T00:00:00.000Z");
  assert.equal(track.points[2].timestamp, "2023-01-01T00:10:00.000Z");
});

test("filterByBoundingBox keeps only points inside the box", () => {
  // A box around Copenhagen; excludes the Gothenburg-area Class B vessel.
  const cph = filterByBoundingBox(records, {
    minLat: 55,
    maxLat: 56,
    minLon: 12,
    maxLon: 13,
  });
  assert.ok(cph.every((r) => r.mmsi === "219000001"));
  assert.equal(cph.length, 3);
});

test("filterByTimeRange honors inclusive bounds", () => {
  const window = filterByTimeRange(records, {
    start: "2023-01-01T00:05:00Z",
    end: "2023-01-01T00:06:00Z",
  });
  const mmsis = new Set(window.map((r) => r.mmsi));
  assert.deepEqual([...mmsis].sort(), ["219000001", "265000002"]);
  assert.equal(window.length, 2);
});
