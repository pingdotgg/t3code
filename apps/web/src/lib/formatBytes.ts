function formatScaled(value: number): string {
  const twoDecimals = value.toFixed(2);
  if (Number(twoDecimals) < 10) return twoDecimals;
  const oneDecimal = value.toFixed(1);
  if (Number(oneDecimal) < 100) return oneDecimal;
  return value.toFixed(0);
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
