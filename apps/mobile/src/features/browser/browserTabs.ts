import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export function latestBrowserTab(tabs: ReadonlyArray<PreviewSessionSnapshot>) {
  return tabs.reduce<PreviewSessionSnapshot | null>(
    (latest, tab) => (latest === null || tab.updatedAt > latest.updatedAt ? tab : latest),
    null,
  );
}

export function browserTabUrl(tab: PreviewSessionSnapshot) {
  return tab.navStatus._tag === "Idle" ? "" : tab.navStatus.url;
}

export function browserTabTitle(tab: PreviewSessionSnapshot, resolve: MessageResolver = m) {
  if (tab.navStatus._tag === "Idle") return resolve(msg("New tab"));
  if (tab.navStatus.title.trim()) return tab.navStatus.title;
  try {
    return new URL(tab.navStatus.url).host || tab.navStatus.url;
  } catch {
    return tab.navStatus.url;
  }
}

/** The tab's URL for this device's tunnelled webview, when it is one of the environment's loopback pages. */
export function loopbackUrlForDevice(value: string): string | null {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    // The unspecified address would name this device's own interfaces, so use localhost instead.
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "localhost";
    if (!isLoopbackHost(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The address a local preview loads for `value`: an http(s) URL, or null when it is anything else. */
export function localPreviewUrlForDevice(value: string): string | null {
  const loopback = loopbackUrlForDevice(value);
  if (loopback !== null) return loopback;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}
