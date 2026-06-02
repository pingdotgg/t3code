export const CF_COLOR = "#F38020";
export const AWS_COLOR = "#2563EB";
export const PS_COLOR = "#56C7B7";
export const AXIOM_COLOR = "#9F6FFF";
export const DD_COLOR = "#632CA6";
export const CW_COLOR = "#E7157B";
export const OTEL_COLOR = "#F5A623";
export const GH_COLOR = "#8B949E";

export function tint(hex: string, a = 0.15): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
