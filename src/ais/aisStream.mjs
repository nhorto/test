// AISStream.io live collector.
//
// AISStream is a REAL-TIME stream, not an archive: it delivers AIS messages
// from the moment you connect, going forward. Use it to ACCUMULATE history over
// time, not to backfill the past. For past data use the NOAA modules instead.
//
// The API key is read from the AISSTREAM_API_KEY environment variable. Never
// hardcode or commit it.

const DEFAULT_ENDPOINT = "wss://stream.aisstream.io/v0/stream";

// Resolve the API key from an explicit option or the environment. Throws if
// neither is set, so a missing key fails loudly rather than silently.
export const resolveApiKey = (explicit) => {
  const key = explicit ?? process.env.AISSTREAM_API_KEY;
  if (!key) {
    throw new Error(
      "AISStream API key missing: set AISSTREAM_API_KEY or pass { apiKey }",
    );
  }
  return key;
};

// Build the subscription frame AISStream expects. `boundingBoxes` is an array
// of [[latMin, lonMin], [latMax, lonMax]] pairs.
export const buildSubscription = ({
  apiKey,
  boundingBoxes,
  filterMessageTypes = ["PositionReport"],
  filterMMSI,
}) => {
  const sub = {
    APIKey: apiKey,
    BoundingBoxes: boundingBoxes ?? [[[-90, -180], [90, 180]]],
  };
  if (filterMessageTypes) {
    sub.FilterMessageTypes = filterMessageTypes;
  }
  if (filterMMSI) {
    sub.FiltersShipMMSI = filterMMSI.map(String);
  }
  return sub;
};

// Normalize one AISStream message into the same record shape the NOAA parser
// produces, so both sources feed the same track-building code. Returns null for
// message types we don't map to a position.
export const normalizeAisStreamMessage = (message) => {
  if (!message || message.MessageType !== "PositionReport") {
    return null;
  }

  const meta = message.MetaData ?? {};
  const report = message.Message?.PositionReport ?? {};

  const lat = report.Latitude ?? meta.latitude ?? null;
  const lon = report.Longitude ?? meta.longitude ?? null;
  const mmsi = meta.MMSI != null ? String(meta.MMSI) : null;
  const time = meta.time_utc ? new Date(meta.time_utc) : null;

  return {
    mmsi,
    timestamp: time && !Number.isNaN(time.getTime()) ? time.toISOString() : null,
    lat,
    lon,
    sog: report.Sog ?? null,
    cog: report.Cog ?? null,
    heading: report.TrueHeading ?? null,
    vesselName: meta.ShipName ? String(meta.ShipName).trim() : null,
    status: report.NavigationalStatus ?? null,
  };
};

// Open a live AISStream connection and invoke `onRecord` for each normalized
// position. Returns a handle with stop(). Requires a global WebSocket
// (Node 22+) and outbound access to aisstream.io.
//
// This is the network boundary; the pure helpers above are unit-tested offline.
export const collectAisStream = ({
  apiKey,
  boundingBoxes,
  filterMessageTypes,
  filterMMSI,
  onRecord,
  onError,
  endpoint = DEFAULT_ENDPOINT,
  WebSocketImpl = globalThis.WebSocket,
} = {}) => {
  if (typeof WebSocketImpl !== "function") {
    throw new Error("No WebSocket implementation available (need Node 22+)");
  }
  const key = resolveApiKey(apiKey);
  const subscription = buildSubscription({
    apiKey: key,
    boundingBoxes,
    filterMessageTypes,
    filterMMSI,
  });

  const ws = new WebSocketImpl(endpoint);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify(subscription));
  });

  ws.addEventListener("message", (event) => {
    try {
      const data =
        typeof event.data === "string" ? event.data : event.data.toString();
      const record = normalizeAisStreamMessage(JSON.parse(data));
      if (record && onRecord) {
        onRecord(record);
      }
    } catch (err) {
      onError?.(err);
    }
  });

  ws.addEventListener("error", (event) => {
    onError?.(event.error ?? new Error("AISStream socket error"));
  });

  return {
    socket: ws,
    stop: () => ws.close(),
  };
};
