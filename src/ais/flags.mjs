// Flag-state identification from an MMSI's Maritime Identification Digits (MID).
//
// The first three digits of a 9-digit MMSI are the MID, which maps to the
// vessel's declared flag state. NOTE: an MMSI is *self-declared* and can be
// spoofed — treat flag attribution as a strong hint, not proof.

// Focused MID table: Russia + the Baltic/North Sea region (DMA's coverage) plus
// the major open-registry and great-power flags one tends to see transiting.
// Not exhaustive; unknown MIDs fall back to "Unknown".
export const MID_TO_FLAG = {
  // Russia (the focus) — incl. Kaliningrad / Baltic Fleet home waters.
  273: { code: "RU", name: "Russia" },
  // Ukraine, for contrast in the same theatre.
  272: { code: "UA", name: "Ukraine" },
  // Baltic / North Sea neighbours.
  219: { code: "DK", name: "Denmark" }, 220: { code: "DK", name: "Denmark" },
  265: { code: "SE", name: "Sweden" }, 266: { code: "SE", name: "Sweden" },
  230: { code: "FI", name: "Finland" },
  257: { code: "NO", name: "Norway" }, 258: { code: "NO", name: "Norway" }, 259: { code: "NO", name: "Norway" },
  211: { code: "DE", name: "Germany" }, 218: { code: "DE", name: "Germany" },
  261: { code: "PL", name: "Poland" },
  276: { code: "EE", name: "Estonia" },
  275: { code: "LV", name: "Latvia" },
  277: { code: "LT", name: "Lithuania" },
  244: { code: "NL", name: "Netherlands" }, 245: { code: "NL", name: "Netherlands" }, 246: { code: "NL", name: "Netherlands" },
  205: { code: "BE", name: "Belgium" },
  232: { code: "GB", name: "United Kingdom" }, 233: { code: "GB", name: "United Kingdom" }, 234: { code: "GB", name: "United Kingdom" }, 235: { code: "GB", name: "United Kingdom" },
  226: { code: "FR", name: "France" }, 227: { code: "FR", name: "France" }, 228: { code: "FR", name: "France" },
  // Common open registries / great powers seen in transit.
  636: { code: "LR", name: "Liberia" }, 637: { code: "LR", name: "Liberia" },
  538: { code: "MH", name: "Marshall Islands" },
  215: { code: "MT", name: "Malta" }, 229: { code: "MT", name: "Malta" }, 248: { code: "MT", name: "Malta" }, 249: { code: "MT", name: "Malta" }, 256: { code: "MT", name: "Malta" },
  352: { code: "PA", name: "Panama" }, 353: { code: "PA", name: "Panama" }, 354: { code: "PA", name: "Panama" }, 355: { code: "PA", name: "Panama" }, 356: { code: "PA", name: "Panama" }, 357: { code: "PA", name: "Panama" }, 370: { code: "PA", name: "Panama" }, 371: { code: "PA", name: "Panama" }, 372: { code: "PA", name: "Panama" }, 373: { code: "PA", name: "Panama" },
  338: { code: "US", name: "United States" }, 366: { code: "US", name: "United States" }, 367: { code: "US", name: "United States" }, 368: { code: "US", name: "United States" }, 369: { code: "US", name: "United States" },
  412: { code: "CN", name: "China" }, 413: { code: "CN", name: "China" }, 414: { code: "CN", name: "China" },
};

// First three digits of a valid 9-digit MMSI.
export const getMid = (mmsi) => {
  if (typeof mmsi !== "string" || !/^\d{9}$/.test(mmsi)) return null;
  return Number(mmsi.slice(0, 3));
};

// Resolve flag info from an MMSI. Returns an "Unknown" entry (with the raw MID)
// rather than null so callers always get a usable label.
export const getFlagInfo = (mmsi) => {
  const mid = getMid(mmsi);
  if (mid == null) return { code: "??", name: "Invalid MMSI", mid: null };
  return { ...(MID_TO_FLAG[mid] ?? { code: "??", name: `Unknown (MID ${mid})` }), mid };
};

// Convenience: does this MMSI declare the given ISO flag code (e.g. "RU")?
export const isFlag = (mmsi, code) => getFlagInfo(mmsi).code === code;

// The focus of this analysis.
export const isRussianFlag = (mmsi) => getMid(mmsi) === 273;
