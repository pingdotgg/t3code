export function formatDiagnosticsDuration(value: number): string {
  const milliseconds = Math.round(value);
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0+$/, "")} s`;
}
