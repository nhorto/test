import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import { downloadAisCsv, fetchHistoricalAis } from "../fetchHistoricalAis.mjs";

// Reuse the same minimal zip writer shape the unzip test uses.
const buildCsvZip = (name, content) => {
  const nameBuf = Buffer.from(name, "utf8");
  const data = deflateRawSync(Buffer.from(content, "utf8"));

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(Buffer.byteLength(content), 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(Buffer.byteLength(content), 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  nameBuf.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + data.length, 16);

  return Buffer.concat([local, data, central, eocd]);
};

const CSV = "MMSI,BaseDateTime,LAT,LON\n367000010,2023-01-01T00:00:02,40.6,-74.0\n";

// A fake fetch that returns our in-memory zip and records the requested URL.
const stubFetch = (zip, captured) => async (url) => {
  captured.url = url;
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
  };
};

test("downloadAisCsv hits the right URL and decodes the zip", async () => {
  const zip = buildCsvZip("AIS_2023_01_01.csv", CSV);
  const captured = {};
  const { url, csv } = await downloadAisCsv("2023-01-01", {
    fetchImpl: stubFetch(zip, captured),
  });

  assert.match(captured.url, /AIS_2023_01_01\.zip$/);
  assert.equal(url, captured.url);
  assert.equal(csv, CSV);
});

test("fetchHistoricalAis parses records and builds tracks", async () => {
  const zip = buildCsvZip("AIS_2023_01_01.csv", CSV);
  const { records, tracks } = await fetchHistoricalAis("2023-01-01", {
    fetchImpl: stubFetch(zip, {}),
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].mmsi, "367000010");
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].points.length, 1);
});

test("fetchHistoricalAis applies a bounding-box filter", async () => {
  const zip = buildCsvZip("AIS_2023_01_01.csv", CSV);
  const { records } = await fetchHistoricalAis("2023-01-01", {
    fetchImpl: stubFetch(zip, {}),
    boundingBox: { minLat: 0, maxLat: 10, minLon: 0, maxLon: 10 },
  });
  assert.equal(records.length, 0, "the NY point is outside the box");
});

test("a non-OK response throws", async () => {
  const failing = async () => ({ ok: false, status: 403 });
  await assert.rejects(
    () => downloadAisCsv("2023-01-01", { fetchImpl: failing }),
    /403/,
  );
});
