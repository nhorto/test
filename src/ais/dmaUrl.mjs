// Build download URLs for the Danish Maritime Authority (DMA) open AIS archive.
//
// DMA publishes free, historical AIS at https://web.ais.dk/aisdata/ — no auth.
// Recent data is one zip per day:
//     https://web.ais.dk/aisdata/aisdk-{YYYY}-{MM}-{DD}.zip
// Older data (early years) was published per month:
//     https://web.ais.dk/aisdata/aisdk-{YYYY}-{MM}.zip
// Each zip contains a single CSV of the same base name.

const BASE_URL = "https://web.ais.dk/aisdata";

const pad2 = (value) => String(value).padStart(2, "0");

// Accepts a Date, an ISO string, or a { year, month, day } object and returns
// normalized numeric parts. Month is 1-12.
const normalizeDateParts = (input) => {
  if (input && typeof input === "object" && !(input instanceof Date)) {
    const { year, month, day } = input;
    return { year, month, day };
  }

  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for DMA AIS URL: ${String(input)}`);
  }

  // DMA filenames are in UTC.
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
};

// Daily archive URL (the common case for recent years).
export const buildDailyUrl = (input) => {
  const { year, month, day } = normalizeDateParts(input);
  return `${BASE_URL}/aisdk-${year}-${pad2(month)}-${pad2(day)}.zip`;
};

// Monthly archive URL (used for some early years).
export const buildMonthlyUrl = (input) => {
  const { year, month } = normalizeDateParts(input);
  return `${BASE_URL}/aisdk-${year}-${pad2(month)}.zip`;
};

// Default helper: daily granularity. Pass { granularity: "monthly" } for the
// older monthly archives.
export const buildHistoricalUrl = (input, { granularity = "daily" } = {}) =>
  granularity === "monthly" ? buildMonthlyUrl(input) : buildDailyUrl(input);
