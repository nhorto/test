import test from "node:test";
import assert from "node:assert/strict";

import { parseCsvRows, parseCsvObjects } from "../parseCsv.mjs";

test("parses simple rows", () => {
  const rows = parseCsvRows("a,b,c\n1,2,3");
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("handles quoted commas and escaped quotes", () => {
  const rows = parseCsvRows('name,note\n"Doe, John","said ""hi"""');
  assert.deepEqual(rows, [
    ["name", "note"],
    ["Doe, John", 'said "hi"'],
  ]);
});

test("handles CRLF line endings and ignores trailing newline", () => {
  const rows = parseCsvRows("a,b\r\n1,2\r\n");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("preserves quoted newlines within a field", () => {
  const rows = parseCsvRows('a,b\n"line1\nline2",x');
  assert.deepEqual(rows, [
    ["a", "b"],
    ["line1\nline2", "x"],
  ]);
});

test("parseCsvObjects keys cells by header", () => {
  const objects = parseCsvObjects("x,y\n1,2\n3,4");
  assert.deepEqual(objects, [
    { x: "1", y: "2" },
    { x: "3", y: "4" },
  ]);
});

test("empty input yields no objects", () => {
  assert.deepEqual(parseCsvObjects(""), []);
});
