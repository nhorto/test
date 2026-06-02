import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseAisCsv } from "../parseAis.mjs";
import {
  buildTracks,
  filterByBoundingBox,
  filterByTimeRange,
} from "../tracks.mjs";

const fixture = readFileSync(
  fileURLToPath(new URL("../__fixtures__/sample_ais.csv", import.meta.url)),
  "utf8",
);
const records = parseAisCsv(fixture);

test("groups records into per-vessel tracks ordered by time", () => {
  const tracks = buildTracks(records);
  assert.equal(tracks.length, 2);

  const ferry = tracks.find((t) => t.mmsi === "367000010");
  assert.equal(ferry.points.length, 3);
  assert.equal(ferry.vesselName, "STATUE, OF LIBERTY FERRY");
  assert.equal(ferry.start, "2023-01-01T00:00:02.000Z");
  assert.equal(ferry.end, "2023-01-01T00:10:02.000Z");

  const times = ferry.points.map((p) => p.timestamp);
  assert.deepEqual(times, [...times].sort());
});

test("buildTracks sorts out-of-order input", () => {
  const shuffled = [records[2], records[0], records[1]];
  const [track] = buildTracks(shuffled);
  assert.equal(track.points[0].timestamp, "2023-01-01T00:00:02.000Z");
  assert.equal(track.points[2].timestamp, "2023-01-01T00:10:02.000Z");
});

test("filterByBoundingBox keeps only points inside the box", () => {
  // A box around New York harbor; excludes the Miami vessel.
  const nyc = filterByBoundingBox(records, {
    minLat: 40,
    maxLat: 41,
    minLon: -75,
    maxLon: -73,
  });
  assert.ok(nyc.every((r) => r.mmsi === "367000010"));
  assert.equal(nyc.length, 3);
});

test("filterByTimeRange honors inclusive bounds", () => {
  const window = filterByTimeRange(records, {
    start: "2023-01-01T00:05:00Z",
    end: "2023-01-01T00:06:00Z",
  });
  const mmsis = new Set(window.map((r) => r.mmsi));
  assert.deepEqual([...mmsis].sort(), ["338000020", "367000010"]);
  assert.equal(window.length, 2);
});
