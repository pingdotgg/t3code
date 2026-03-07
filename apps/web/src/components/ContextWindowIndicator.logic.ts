export type ContextWindowSeverity = "default" | "warning" | "danger";

export function resolveContextWindowSeverity(usedPercent: number): ContextWindowSeverity {
  if (usedPercent >= 90) {
    return "danger";
  }
  if (usedPercent >= 70) {
    return "warning";
  }
  return "default";
}

export function formatCompactTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = Math.round((value / 1_000_000) * 10) / 10;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}m`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    const rounded = thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
  }
  return value.toLocaleString("en-US");
}
