export const formatDateWithDetail = (isoDate, detail) => {
  if (!isoDate) {
    return detail ?? "";
  }

  const parsedDate = new Date(isoDate);
  if (Number.isNaN(parsedDate.getTime())) {
    return detail ?? "";
  }

  const formattedDate = parsedDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return detail ? `${formattedDate} • ${detail}` : formattedDate;
};

const getTimestamp = (item, key) => {
  const value = item?.[key];
  const date = new Date(value);
  const timestamp = date.getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

export const sortByDate = (items, direction = "desc", key = "date") => {
  const sorted = items
    .slice()
    .sort((a, b) => getTimestamp(a, key) - getTimestamp(b, key));
  return direction === "asc" ? sorted : sorted.reverse();
};
