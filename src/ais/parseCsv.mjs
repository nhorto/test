// Minimal, dependency-free CSV parser.
//
// Handles the cases that appear in NOAA AIS exports: quoted fields, commas and
// newlines inside quotes, and escaped quotes (""). Returns an array of string
// arrays (one per row). Empty trailing lines are ignored.

export const parseCsvRows = (text) => {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let sawAnyChar = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };

  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    sawAnyChar = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      sawAnyChar = true;
    } else if (char === ",") {
      pushField();
      sawAnyChar = true;
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      // Swallow CR; the following LF (if any) terminates the row.
    } else {
      field += char;
      sawAnyChar = true;
    }
  }

  // Flush a final row that wasn't newline-terminated.
  if (sawAnyChar || field.length > 0 || row.length > 0) {
    pushRow();
  }

  return rows;
};

// Parse CSV into objects keyed by the header row.
export const parseCsvObjects = (text) => {
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    return [];
  }

  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const record = {};
    header.forEach((key, index) => {
      record[key] = cells[index] ?? "";
    });
    return record;
  });
};
