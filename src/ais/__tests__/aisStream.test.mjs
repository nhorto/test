import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveApiKey,
  buildSubscription,
  normalizeAisStreamMessage,
} from "../aisStream.mjs";

test("resolveApiKey prefers an explicit key, falls back to env", () => {
  assert.equal(resolveApiKey("explicit"), "explicit");

  const prev = process.env.AISSTREAM_API_KEY;
  process.env.AISSTREAM_API_KEY = "from-env";
  try {
    assert.equal(resolveApiKey(), "from-env");
  } finally {
    if (prev === undefined) {
      delete process.env.AISSTREAM_API_KEY;
    } else {
      process.env.AISSTREAM_API_KEY = prev;
    }
  }
});

test("resolveApiKey throws when no key is available", () => {
  const prev = process.env.AISSTREAM_API_KEY;
  delete process.env.AISSTREAM_API_KEY;
  try {
    assert.throws(() => resolveApiKey(), /AISSTREAM_API_KEY/);
  } finally {
    if (prev !== undefined) {
      process.env.AISSTREAM_API_KEY = prev;
    }
  }
});

test("buildSubscription defaults to a worldwide PositionReport subscription", () => {
  const sub = buildSubscription({ apiKey: "k" });
  assert.equal(sub.APIKey, "k");
  assert.deepEqual(sub.BoundingBoxes, [[[-90, -180], [90, 180]]]);
  assert.deepEqual(sub.FilterMessageTypes, ["PositionReport"]);
});

test("buildSubscription passes through bounding boxes and MMSI filters", () => {
  const sub = buildSubscription({
    apiKey: "k",
    boundingBoxes: [[[40, -75], [41, -73]]],
    filterMMSI: [367000010],
  });
  assert.deepEqual(sub.BoundingBoxes, [[[40, -75], [41, -73]]]);
  assert.deepEqual(sub.FiltersShipMMSI, ["367000010"]);
});

test("normalizeAisStreamMessage maps a PositionReport to a record", () => {
  const record = normalizeAisStreamMessage({
    MessageType: "PositionReport",
    MetaData: {
      MMSI: 367000010,
      ShipName: "  TEST VESSEL ",
      time_utc: "2023-01-01 00:00:02.000000000 +0000 UTC",
    },
    Message: {
      PositionReport: {
        Latitude: 40.6892,
        Longitude: -74.0445,
        Sog: 12.3,
        Cog: 98.4,
        TrueHeading: 99,
        NavigationalStatus: 0,
      },
    },
  });

  assert.equal(record.mmsi, "367000010");
  assert.equal(record.lat, 40.6892);
  assert.equal(record.lon, -74.0445);
  assert.equal(record.sog, 12.3);
  assert.equal(record.heading, 99);
  assert.equal(record.vesselName, "TEST VESSEL");
  assert.equal(record.timestamp, "2023-01-01T00:00:02.000Z");
});

test("normalizeAisStreamMessage ignores non-position messages", () => {
  assert.equal(
    normalizeAisStreamMessage({ MessageType: "ShipStaticData" }),
    null,
  );
  assert.equal(normalizeAisStreamMessage(null), null);
});
