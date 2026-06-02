import test from "node:test";
import assert from "node:assert/strict";

import { buildDailyUrl, buildMonthlyUrl, buildHistoricalUrl } from "../dmaUrl.mjs";

const BASE = "https://web.ais.dk/aisdata";

test("builds a daily URL from a Date (UTC)", () => {
  assert.equal(
    buildDailyUrl(new Date("2023-01-05T00:00:00Z")),
    `${BASE}/aisdk-2023-01-05.zip`,
  );
});

test("builds a daily URL from date parts", () => {
  assert.equal(
    buildDailyUrl({ year: 2020, month: 12, day: 9 }),
    `${BASE}/aisdk-2020-12-09.zip`,
  );
});

test("builds a monthly URL for older archives", () => {
  assert.equal(
    buildMonthlyUrl({ year: 2010, month: 3 }),
    `${BASE}/aisdk-2010-03.zip`,
  );
});

test("buildHistoricalUrl defaults to daily and honors granularity", () => {
  assert.equal(
    buildHistoricalUrl("2023-06-15"),
    `${BASE}/aisdk-2023-06-15.zip`,
  );
  assert.equal(
    buildHistoricalUrl("2010-06-15", { granularity: "monthly" }),
    `${BASE}/aisdk-2010-06.zip`,
  );
});

test("invalid date throws", () => {
  assert.throws(() => buildDailyUrl("not-a-date"), /Invalid date/);
});
