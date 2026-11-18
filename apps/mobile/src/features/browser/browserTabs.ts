import type { PreviewSessionSnapshot } from "@t3tools/contracts";
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
