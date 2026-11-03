function formatScaled(value: number): string {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
}

export function formatBytes(value: number): string {
  if (Math.round(value) < 1_024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let next = value / 1_024;
  let unitIndex = 0;
  // Pick the unit after rounding, so 1023.6 KB reads "1.00 MB", not "1024 KB".
  while (Number(formatScaled(next)) >= 1_024 && unitIndex < units.length - 1) {
    next /= 1_024;
    unitIndex += 1;
  }
  return `${formatScaled(next)} ${units[unitIndex]}`;
}
