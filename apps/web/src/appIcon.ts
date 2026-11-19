import {
  APP_ICONS,
  DEFAULT_APP_ICON,
  appIconFileName,
  resolveAppIconId,
} from "@t3tools/shared/appIcons";
import { msg } from "gt-react";

/** "Default" first, showing the build's own icon. */
export const APP_ICON_OPTIONS = [
  {
    id: DEFAULT_APP_ICON,
    label: msg("Default", { $context: "app icon option" }),
    src: "/apple-touch-icon.png",
  },
  ...APP_ICONS.map(({ id, label }) => ({
    id,
    label,
    src: `/app-icons/${appIconFileName(id, "universal")}`,
  })),
];

export function appIconOption(appIcon: string) {
  const id = resolveAppIconId(appIcon) ?? DEFAULT_APP_ICON;
  return APP_ICON_OPTIONS.find((option) => option.id === id) ?? APP_ICON_OPTIONS[0]!;
}

/** Points the tab favicon at the chosen icon, keeping index.html's own link for Default. */
export function applyAppIconFavicon(appIcon: string): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  link.dataset.defaultHref ??= link.getAttribute("href") ?? "";
  link.dataset.defaultSizes ??= link.getAttribute("sizes") ?? "";
  const id = resolveAppIconId(appIcon);
  link.setAttribute(
    "href",
    id === null ? link.dataset.defaultHref : `/app-icons/${appIconFileName(id, "favicon")}`,
  );
  link.setAttribute("sizes", id === null ? link.dataset.defaultSizes : "32x32");
}
