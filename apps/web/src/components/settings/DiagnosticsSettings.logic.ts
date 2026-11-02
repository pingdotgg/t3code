export function formatDiagnosticsDuration(value: number): string {
  if (Math.round(value) < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0+$/, "")} s`;
}
