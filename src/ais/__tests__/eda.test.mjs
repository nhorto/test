import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseDmaCsv } from "../parseDmaAis.mjs";
import {
  quantile,
  summarize,
  valueCounts,
  haversineNm,
  computeEda,
  formatEdaReport,
} from "../eda.mjs";

const records = parseDmaCsv(
  readFileSync(
    fileURLToPath(new URL("../__fixtures__/sample_aisdk.csv", import.meta.url)),
    "utf8",
  ),
);

test("quantile interpolates", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([10], 0.9), 10);
  assert.equal(quantile([], 0.5), null);
});

test("summarize reports core statistics, ignoring nulls", () => {
  const s = summarize([1, 2, 3, null, 4]);
  assert.equal(s.count, 4);
  assert.equal(s.min, 1);
  assert.equal(s.max, 4);
  assert.equal(s.mean, 2.5);
  assert.equal(s.median, 2.5);
});

test("valueCounts sorts by frequency and can cap with top", () => {
  const counts = valueCounts(["a", "b", "a", "a", "b", "c"], { top: 2 });
  assert.deepEqual(counts, [
    ["a", 3],
    ["b", 2],
  ]);
});

test("haversineNm matches a known distance (~roughly)", () => {
  // ~1 degree of latitude ≈ 60 nautical miles.
  const d = haversineNm(55, 12, 56, 12);
  assert.ok(Math.abs(d - 60) < 1, `expected ~60 nm, got ${d}`);
});

test("computeEda produces a coherent summary of the fixture", () => {
  const eda = computeEda(records);
  assert.equal(eda.totalRecords, 5);
  assert.equal(eda.uniqueVessels, 2);
  assert.equal(eda.timeRange.start, "2023-01-01T00:00:00.000Z");
  assert.equal(eda.timeRange.end, "2023-01-01T00:10:00.000Z");
  assert.ok(eda.boundingBox.minLat >= 55 && eda.boundingBox.maxLat <= 58);

  // The Maersk vessel moves ~3 nm across the harbor; pleasure craft a bit less.
  assert.ok(eda.distanceNmPerVessel.max > 0);
  // Ship-type distribution should include Cargo and Pleasure.
  const types = Object.fromEntries(eda.byShipType);
  assert.ok(types.Cargo >= 3);
  assert.ok(types.Pleasure >= 2);
});

test("formatEdaReport renders markdown sections", () => {
  const report = formatEdaReport(computeEda(records));
  assert.match(report, /# AIS Exploratory Data Analysis/);
  assert.match(report, /## Speed over ground/);
  assert.match(report, /## By ship type/);
});
