import test from "node:test";
import assert from "node:assert/strict";

import { classifyVessel, isMilitary, isLawEnforcement } from "../classify.mjs";

test("classifies by DMA text ship type", () => {
  assert.equal(classifyVessel({ vesselType: "Military" }).category, "military");
  assert.equal(classifyVessel({ vesselType: "Law enforcement" }).category, "law_enforcement");
  assert.equal(classifyVessel({ vesselType: "SAR" }).category, "sar");
  assert.equal(classifyVessel({ vesselType: "Cargo" }).category, "other");
});

test("classifies by numeric AIS ship-type code", () => {
  assert.equal(classifyVessel({ aisShipType: 35 }).category, "military");
  assert.equal(classifyVessel({ aisShipType: 55 }).category, "law_enforcement");
  assert.equal(classifyVessel({ aisShipType: 51 }).category, "sar");
});

test("watchlist matches by MMSI and by name fragment", () => {
  const watchlist = { mmsi: ["273123456"], names: ["Admiral"] };
  const byMmsi = classifyVessel({ mmsi: "273123456", vesselType: "Cargo" }, { watchlist });
  assert.equal(byMmsi.category, "military");
  assert.ok(byMmsi.signals.includes("watchlist_mmsi"));

  const byName = classifyVessel({ mmsi: "273000000", vesselName: "ADMIRAL GORSHKOV" }, { watchlist });
  assert.equal(byName.category, "military");
  assert.ok(byName.signals.includes("watchlist_name"));
});

test("isMilitary / isLawEnforcement helpers", () => {
  assert.equal(isMilitary({ vesselType: "Military operations" }), true);
  assert.equal(isMilitary({ vesselType: "Tanker" }), false);
  assert.equal(isLawEnforcement({ aisShipType: 55 }), true);
});
