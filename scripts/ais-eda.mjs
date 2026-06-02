#!/usr/bin/env node
// Run exploratory data analysis on AIS data.
//
// Usage:
//   node scripts/ais-eda.mjs <path-to.csv|path-to.zip>          # local file
//   node scripts/ais-eda.mjs --date 2023-01-01                  # fetch from DMA (needs network)
//   node scripts/ais-eda.mjs <input> --bbox 54,57,10,13        # lat/lat/lon/lon filter
//   node scripts/ais-eda.mjs <input> --out report.md           # write report to file
//
// Works fully offline against a local CSV or zip; the --date mode requires
// outbound access to web.ais.dk.

import { readFileSync, writeFileSync } from "node:fs";

import { extractFirstCsv } from "../src/ais/unzip.mjs";
import { parseDmaCsv } from "../src/ais/parseDmaAis.mjs";
import { filterByBoundingBox } from "../src/ais/tracks.mjs";
import { fetchDmaAis } from "../src/ais/fetchDmaAis.mjs";
import { computeEda, formatEdaReport } from "../src/ais/eda.mjs";

const args = process.argv.slice(2);
const getFlag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const bboxArg = getFlag("--bbox");
const boundingBox = bboxArg
  ? (() => {
      const [minLat, maxLat, minLon, maxLon] = bboxArg.split(",").map(Number);
      return { minLat, maxLat, minLon, maxLon };
    })()
  : undefined;
const outPath = getFlag("--out");
const date = getFlag("--date");

const loadRecords = async () => {
  if (date) {
    process.stderr.write(`Fetching DMA data for ${date} …\n`);
    const { records } = await fetchDmaAis(date, { boundingBox });
    return records;
  }

  const input = args.find((a) => !a.startsWith("--") && a !== bboxArg && a !== outPath && a !== date);
  if (!input) {
    process.stderr.write("Provide a CSV/zip path or --date YYYY-MM-DD\n");
    process.exit(1);
  }

  const csv = input.toLowerCase().endsWith(".zip")
    ? extractFirstCsv(readFileSync(input))
    : readFileSync(input, "utf8");
  let records = parseDmaCsv(csv);
  if (boundingBox) records = filterByBoundingBox(records, boundingBox);
  return records;
};

const records = await loadRecords();
const report = formatEdaReport(computeEda(records));

if (outPath) {
  writeFileSync(outPath, report + "\n");
  process.stderr.write(`Wrote ${outPath}\n`);
} else {
  process.stdout.write(report + "\n");
}
