// Dependency-free SVG chart generation for AIS EDA.
//
// Produces standalone .svg strings (render in any browser, embed in markdown).
// No plotting library required — handy in restricted environments where npm/pip
// installs are unavailable. PNG conversion, if needed, requires an external
// tool (rsvg-convert / ImageMagick / a browser).

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const svgWrap = (width, height, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
  `viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="11">` +
  `<rect width="${width}" height="${height}" fill="white"/>${body}</svg>`;

// Bin numeric values into `bins` equal-width buckets.
export const histogram = (values, bins = 20) => {
  const nums = values.filter((v) => v != null && !Number.isNaN(v));
  if (nums.length === 0) return { buckets: [], min: 0, max: 0 };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const buckets = new Array(bins).fill(0);
  for (const v of nums) {
    const idx = Math.min(bins - 1, Math.floor(((v - min) / span) * bins));
    buckets[idx] += 1;
  }
  return { buckets, min, max };
};

// Generic vertical bar chart from labels + values.
export const barChartSvg = (labels, values, { title = "", width = 720, height = 320 } = {}) => {
  const padL = 50, padR = 16, padT = 36, padB = 70;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const maxV = Math.max(1, ...values);
  const barW = plotW / Math.max(1, values.length);

  let body = `<text x="${padL}" y="22" font-size="14" font-weight="bold">${esc(title)}</text>`;
  body += `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#999"/>`;
  body += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#999"/>`;
  body += `<text x="${padL - 6}" y="${padT + 6}" text-anchor="end">${maxV}</text>`;

  values.forEach((v, i) => {
    const h = (v / maxV) * plotH;
    const x = padL + i * barW + barW * 0.1;
    const y = padT + plotH - h;
    body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW * 0.8).toFixed(1)}" height="${h.toFixed(1)}" fill="#3b78c3"/>`;
    if (labels[i] != null) {
      const lx = x + barW * 0.4;
      const ly = padT + plotH + 12;
      body += `<text x="${lx.toFixed(1)}" y="${ly}" text-anchor="end" transform="rotate(-45 ${lx.toFixed(1)} ${ly})">${esc(labels[i])}</text>`;
    }
  });
  return svgWrap(width, height, body);
};

// Histogram chart for a numeric series (e.g. speed over ground).
export const histogramSvg = (values, { title = "", bins = 20, unit = "" } = {}) => {
  const { buckets, min, max } = histogram(values, bins);
  const step = (max - min) / bins || 1;
  const labels = buckets.map((_, i) => `${(min + i * step).toFixed(0)}${unit}`);
  return barChartSvg(labels, buckets, { title });
};

// Scatter "map" of vessel positions (lon = x, lat = y), optionally colored by
// MMSI to hint at distinct tracks.
export const trackMapSvg = (records, { title = "Vessel positions", width = 640, height = 640 } = {}) => {
  const pts = records.filter((r) => r.lat != null && r.lon != null);
  if (pts.length === 0) return svgWrap(width, height, `<text x="20" y="30">No positions</text>`);

  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const pad = 40;
  const sx = (lon) => pad + ((lon - minLon) / (maxLon - minLon || 1)) * (width - 2 * pad);
  const sy = (lat) => height - pad - ((lat - minLat) / (maxLat - minLat || 1)) * (height - 2 * pad);

  const palette = ["#3b78c3", "#c0392b", "#27ae60", "#8e44ad", "#e67e22", "#16a085"];
  const colorOf = (mmsi) => {
    let h = 0;
    for (const ch of String(mmsi)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return palette[h % palette.length];
  };

  let body = `<text x="${pad}" y="24" font-size="14" font-weight="bold">${esc(title)}</text>`;
  for (const p of pts) {
    body += `<circle cx="${sx(p.lon).toFixed(1)}" cy="${sy(p.lat).toFixed(1)}" r="1.6" fill="${colorOf(p.mmsi)}" fill-opacity="0.7"/>`;
  }
  body += `<text x="${pad}" y="${height - 12}" fill="#666">lon ${minLon.toFixed(2)}…${maxLon.toFixed(2)} · lat ${minLat.toFixed(2)}…${maxLat.toFixed(2)}</text>`;
  return svgWrap(width, height, body);
};
