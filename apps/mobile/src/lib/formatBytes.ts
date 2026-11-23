const UNITS = ["KB", "MB", "GB"] as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (true) {
    const isLast = unitIndex === UNITS.length - 1;
    const label = value.toFixed(isLast || value < 10 ? 1 : 0);
    // Pick the unit after rounding, so 1023.9 KB reads "1.0 MB", not "1024 KB".
    if (isLast || Number(label) < 1024) return `${label} ${UNITS[unitIndex]}`;
    value /= 1024;
    unitIndex += 1;
  }
}
