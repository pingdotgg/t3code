import type { ProjectIconOverride } from "@t3tools/contracts";

export const DASHBOARD_ICONS_CDN_URL = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons";

export function dashboardIconUrl(
  icon: Extract<ProjectIconOverride, { kind: "dashboard-icon" }>,
  appearance: "light" | "dark",
): string {
  const file = appearance === "dark" ? (icon.darkFile ?? icon.file) : icon.file;
  return `${DASHBOARD_ICONS_CDN_URL}/${file.slice(file.lastIndexOf(".") + 1)}/${file}`;
}
