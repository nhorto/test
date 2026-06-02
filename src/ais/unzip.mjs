// Minimal, dependency-free ZIP reader.
//
// NOAA serves each AIS dataset as a .zip containing a single CSV. Node has no
// built-in zip support (only gzip via zlib), so we parse the archive's central
// directory and inflate deflate-compressed entries with zlib.inflateRawSync.
// Only the two methods NOAA uses are supported: stored (0) and deflate (8).

import { inflateRawSync } from "node:zlib";

const SIG_EOCD = 0x06054b50; // End of central directory
const SIG_CENTRAL = 0x02014b50; // Central directory file header
const SIG_LOCAL = 0x04034b50; // Local file header

// Scan backwards for the End Of Central Directory record. It is at least 22
// bytes from the end, plus an optional comment of up to 65535 bytes.
const findEocdOffset = (buf) => {
  const minOffset = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      return i;
    }
  }
  throw new Error("Not a valid zip file: end-of-central-directory not found");
};

// Extract every file entry as { name, data: Buffer }.
export const extractZipEntries = (input) => {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const eocd = findEocdOffset(buf);

  const totalEntries = buf.readUInt16LE(eocd + 10);
  let pointer = buf.readUInt32LE(eocd + 16); // start of central directory

  const entries = [];
  for (let i = 0; i < totalEntries; i += 1) {
    if (buf.readUInt32LE(pointer) !== SIG_CENTRAL) {
      throw new Error("Corrupt zip: bad central directory header");
    }

    const method = buf.readUInt16LE(pointer + 10);
    const compressedSize = buf.readUInt32LE(pointer + 20);
    const nameLen = buf.readUInt16LE(pointer + 28);
    const extraLen = buf.readUInt16LE(pointer + 30);
    const commentLen = buf.readUInt16LE(pointer + 32);
    const localOffset = buf.readUInt32LE(pointer + 42);
    const name = buf.toString("utf8", pointer + 46, pointer + 46 + nameLen);

    // Jump to the local header to find where the entry's data begins; the
    // local header's name/extra lengths can differ from the central one.
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`Corrupt zip: bad local header for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(`Unsupported zip compression method ${method} for ${name}`);
    }

    entries.push({ name, data });
    pointer += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
};

// Convenience: return the text of the first CSV entry (or the first entry if
// none end in .csv).
export const extractFirstCsv = (input) => {
  const entries = extractZipEntries(input);
  if (entries.length === 0) {
    throw new Error("Zip archive is empty");
  }
  const csv =
    entries.find((e) => e.name.toLowerCase().endsWith(".csv")) ?? entries[0];
  return csv.data.toString("utf8");
};
