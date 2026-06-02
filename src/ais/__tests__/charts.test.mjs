import test from "node:test";
import assert from "node:assert/strict";

import { histogram, histogramSvg, barChartSvg, trackMapSvg } from "../charts.mjs";

test("histogram bins values into equal-width buckets", () => {
  const { buckets, min, max } = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
  assert.equal(buckets.length, 5);
  assert.equal(min, 0);
  assert.equal(max, 9);
  assert.equal(buckets.reduce((a, b) => a + b, 0), 10);
});

test("histogram handles an empty series", () => {
  assert.deepEqual(histogram([], 5), { buckets: [], min: 0, max: 0 });
});

test("histogramSvg returns valid-looking SVG", () => {
  const svg = histogramSvg([1, 2, 2, 3, 5, 8], { title: "Speed", unit: "kn" });
  assert.match(svg, /^<svg/);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /Speed/);
  assert.match(svg, /<rect/);
});

test("barChartSvg escapes labels", () => {
  const svg = barChartSvg(["a<b", "c&d"], [1, 2], { title: "T" });
  assert.match(svg, /a&lt;b/);
  assert.match(svg, /c&amp;d/);
});

test("trackMapSvg plots one circle per position", () => {
  const records = [
    { mmsi: "1", lat: 55, lon: 12 },
    { mmsi: "1", lat: 55.1, lon: 12.1 },
    { mmsi: "2", lat: 56, lon: 11 },
  ];
  const svg = trackMapSvg(records);
  const circles = svg.match(/<circle/g) ?? [];
  assert.equal(circles.length, 3);
});

test("trackMapSvg handles no positions gracefully", () => {
  const svg = trackMapSvg([{ mmsi: "1", lat: null, lon: null }]);
  assert.match(svg, /No positions/);
});
