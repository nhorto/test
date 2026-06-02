import test from "node:test";
import assert from "node:assert/strict";

import { getMid, getFlagInfo, isFlag, isRussianFlag } from "../flags.mjs";

test("getMid extracts the leading three digits of a valid MMSI", () => {
  assert.equal(getMid("273123456"), 273);
  assert.equal(getMid("219000001"), 219);
  assert.equal(getMid("12345"), null);
  assert.equal(getMid("abcdefghi"), null);
});

test("getFlagInfo resolves known flags and labels unknown MIDs", () => {
  assert.deepEqual(getFlagInfo("273123456"), { code: "RU", name: "Russia", mid: 273 });
  assert.deepEqual(getFlagInfo("219000001"), { code: "DK", name: "Denmark", mid: 219 });
  const unknown = getFlagInfo("999000001");
  assert.equal(unknown.code, "??");
  assert.match(unknown.name, /Unknown \(MID 999\)/);
});

test("isFlag and isRussianFlag", () => {
  assert.equal(isFlag("273123456", "RU"), true);
  assert.equal(isFlag("219000001", "RU"), false);
  assert.equal(isRussianFlag("273900900"), true);
  assert.equal(isRussianFlag("265000002"), false);
});
