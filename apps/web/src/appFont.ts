import type { AppFont } from "@t3tools/contracts/settings";

export const APP_FONT_MAP = {
  mono: "'Fira Code', monospace",
  "dm-sans": "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  sans: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
} satisfies Record<AppFont, string>;

export function applyAppFont(font: AppFont): void {
  document.documentElement.style.setProperty("--app-font-family", APP_FONT_MAP[font]);
}
