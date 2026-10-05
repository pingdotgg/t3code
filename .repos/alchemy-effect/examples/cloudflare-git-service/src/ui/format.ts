/** Presentation helpers shared by the pages. */

export const timeAgo = (epochMs: number): string => {
  const s = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.floor(mo / 12);
  return `${y} year${y === 1 ? "" : "s"} ago`;
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
};

export const shortOid = (oid: string): string => oid.slice(0, 7);

/** First line of a commit message. */
export const subject = (message: string): string =>
  message.split("\n", 1)[0] ?? "";

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Decodes bytes as UTF-8, or `null` if the content is binary. */
export const decodeText = (bytes: Uint8Array): string | null => {
  // Quick binary sniff: NUL byte in the first 8 KiB.
  const head = bytes.subarray(0, 8192);
  for (const byte of head) if (byte === 0) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
};

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
};

export const imageMime = (path: string): string | undefined =>
  IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];

export const isMarkdown = (path: string): boolean =>
  /\.(md|markdown)$/i.test(path);
