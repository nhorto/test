// Build download URLs for NOAA Marine Cadastre historical AIS data.
//
// NOAA archives US AIS data on coast.noaa.gov. The layout changed over time:
//   * 2015–present: one national file per day,
//       .../AISDataHandler/{YYYY}/AIS_{YYYY}_{MM}_{DD}.zip
//   * 2009–2014:    one file per month per UTM zone,
//       .../AISDataHandler/{YYYY}/Zone{ZZ}_{YYYY}_{MM}.zip
//
// Each zip contains a single CSV with the same base name.

const BASE_URL = "https://coast.noaa.gov/htdata/CMSP/AISDataHandler";

const DAILY_FORMAT_FIRST_YEAR = 2015;

const pad2 = (value) => String(value).padStart(2, "0");

// Accepts a Date, an ISO string, or a { year, month, day } object and returns
// normalized numeric parts. Month is 1-12 (calendar month, not 0-indexed).
const normalizeDateParts = (input) => {
  if (input && typeof input === "object" && !(input instanceof Date)) {
    const { year, month, day } = input;
    return { year, month, day };
  }

  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for NOAA AIS URL: ${String(input)}`);
  }

  // NOAA filenames are in UTC.
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
};

// Build the daily national-file URL (valid for 2015 onward).
export const buildDailyUrl = (input) => {
  const { year, month, day } = normalizeDateParts(input);
  const name = `AIS_${year}_${pad2(month)}_${pad2(day)}`;
  return `${BASE_URL}/${year}/${name}.zip`;
};

// Build the monthly per-zone URL used for 2009–2014. `zone` is a UTM zone
// number (1-20 for US coverage).
export const buildZoneUrl = (input, zone) => {
  const { year, month } = normalizeDateParts(input);
  if (zone == null) {
    throw new Error("A UTM zone is required for pre-2015 NOAA AIS data");
  }
  const name = `Zone${pad2(zone)}_${year}_${pad2(month)}`;
  return `${BASE_URL}/${year}/${name}.zip`;
};

// Pick the correct URL automatically based on the year. Pre-2015 dates require
// a `zone`; 2015+ dates ignore it.
export const buildHistoricalUrl = (input, { zone } = {}) => {
  const { year } = normalizeDateParts(input);
  return year >= DAILY_FORMAT_FIRST_YEAR
    ? buildDailyUrl(input)
    : buildZoneUrl(input, zone);
};
