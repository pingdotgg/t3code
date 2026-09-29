/** Convert Git's byte counts and binary size suffixes to the MiB used by configuration inputs. */
export function gitLargeFileThresholdMib(value: string | null): string {
  if (value === null) return "";
  const match = /^\+?(\d+)([kmg])?$/i.exec(value.trim());
  if (match === null) return value;
  const unit = match[2]?.toLowerCase();
  const exponent = unit === "g" ? 3 : unit === "m" ? 2 : unit === "k" ? 1 : 0;
  const bytes = Number(match[1]) * 1024 ** exponent;
  return Number.isSafeInteger(bytes)
    ? (bytes / 1024 ** 2).toFixed(20).replace(/\.?0+$/, "")
    : value;
}
