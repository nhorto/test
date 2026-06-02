import test from "node:test";
import assert from "node:assert/strict";

import { buildDailyUrl, buildZoneUrl, buildHistoricalUrl } from "../noaaUrl.mjs";

const BASE = "https://coast.noaa.gov/htdata/CMSP/AISDataHandler";

test("builds a daily URL from a Date (UTC)", () => {
  assert.equal(
    buildDailyUrl(new Date("2023-01-05T00:00:00Z")),
    `${BASE}/2023/AIS_2023_01_05.zip`,
  );
});

test("builds a daily URL from date parts", () => {
  assert.equal(
    buildDailyUrl({ year: 2020, month: 12, day: 9 }),
    `${BASE}/2020/AIS_2020_12_09.zip`,
  );
});

test("builds a zone URL for pre-2015 data", () => {
  assert.equal(
    buildZoneUrl({ year: 2014, month: 3, day: 1 }, 10),
    `${BASE}/2014/Zone10_2014_03.zip`,
  );
});

test("buildHistoricalUrl auto-selects daily vs zone by year", () => {
  assert.equal(
    buildHistoricalUrl("2018-06-15"),
    `${BASE}/2018/AIS_2018_06_15.zip`,
  );
  assert.equal(
    buildHistoricalUrl("2012-06-15", { zone: 1 }),
    `${BASE}/2012/Zone01_2012_06.zip`,
  );
});

test("pre-2015 without a zone throws", () => {
  assert.throws(() => buildHistoricalUrl("2012-06-15"), /zone/i);
});

test("invalid date throws", () => {
  assert.throws(() => buildDailyUrl("not-a-date"), /Invalid date/);
});
