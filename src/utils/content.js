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

export const getExcerptFromText = (text, sentenceCount = 2) => {
  if (!text || typeof text !== "string") {
    return "";
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  const sentences = normalized.match(/[^.!?]+[.!?]*/g);
  if (!sentences) {
    return normalized;
  }

  return sentences.slice(0, Math.max(1, sentenceCount)).join(" ").trim();
};

export const extractTextFromPortableText = (portableText) => {
  if (!portableText || !Array.isArray(portableText)) {
    return "";
  }

  const extractFromBlock = (block) => {
    if (!block || typeof block !== "object") {
      return "";
    }

    if (block._type === "block" && Array.isArray(block.children)) {
      return block.children
        .map((child) => {
          if (child._type === "span" && typeof child.text === "string") {
            return child.text;
          }
          return "";
        })
        .join("");
    }

    return "";
  };

  return portableText
    .map((block) => extractFromBlock(block))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
};
