import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import { extractZipEntries, extractFirstCsv } from "../unzip.mjs";

// Build a minimal single-entry zip so the extractor is tested end-to-end
// without shelling out or committing a binary fixture.
const buildZip = (name, content, { store = false } = {}) => {
  const nameBuf = Buffer.from(name, "utf8");
  const contentBuf = Buffer.from(content, "utf8");
  const data = store ? contentBuf : deflateRawSync(contentBuf);
  const method = store ? 0 : 8;

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(0, 14); // crc (not validated by reader)
  local.writeUInt32LE(data.length, 18); // compressed size
  local.writeUInt32LE(contentBuf.length, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(0, 16); // crc
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(contentBuf.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  nameBuf.copy(central, 46);

  const cdOffset = local.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(central.length, 12); // central dir size
  eocd.writeUInt32LE(cdOffset, 16); // central dir offset

  return Buffer.concat([local, data, central, eocd]);
};

test("extracts a deflate-compressed entry", () => {
  const zip = buildZip("AIS_2023_01_01.csv", "MMSI,LAT,LON\n1,2,3\n");
  const entries = extractZipEntries(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "AIS_2023_01_01.csv");
  assert.equal(entries[0].data.toString("utf8"), "MMSI,LAT,LON\n1,2,3\n");
});

test("extracts a stored (uncompressed) entry", () => {
  const zip = buildZip("data.csv", "hello,world\n", { store: true });
  assert.equal(extractFirstCsv(zip), "hello,world\n");
});

test("extractFirstCsv prefers the .csv entry", () => {
  const zip = buildZip("AIS_2023_01_01.csv", "a,b\n1,2\n");
  assert.equal(extractFirstCsv(zip), "a,b\n1,2\n");
});

test("rejects a non-zip buffer", () => {
  assert.throws(() => extractZipEntries(Buffer.from("not a zip")), /valid zip/);
});
