const UNITS = ["KB", "MB", "GB", "TB"] as const;

function formatScaled(value: number): string {
  return value.toFixed(value < 10 ? 1 : 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unitIndex = 0;
  // Pick the unit after rounding, so 1023.9 KB reads "1.0 MB", not "1024 KB".
  while (Number(formatScaled(value)) >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${formatScaled(value)} ${UNITS[unitIndex]}`;
}
