import type { PreviewSessionSnapshot } from "@t3tools/contracts";

/** The tab the agent touched last, the default when nothing is selected. */
export function latestBrowserTab(tabs: ReadonlyArray<PreviewSessionSnapshot>) {
  return tabs.reduce<PreviewSessionSnapshot | null>(
    (latest, tab) => (latest === null || tab.updatedAt > latest.updatedAt ? tab : latest),
    null,
  );
}

export function browserTabUrl(tab: PreviewSessionSnapshot) {
  return tab.navStatus._tag === "Idle" ? "" : tab.navStatus.url;
}

/** The page's http(s) origin, the only site a saved login can be filled into. */
export function browserTabOrigin(tab: PreviewSessionSnapshot) {
  try {
    const url = new URL(browserTabUrl(tab));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function browserTabTitle(tab: PreviewSessionSnapshot) {
  if (tab.navStatus._tag === "Idle") return "New tab";
  if (tab.navStatus.title.trim()) return tab.navStatus.title;
  try {
    return new URL(tab.navStatus.url).host || tab.navStatus.url;
  } catch {
    return tab.navStatus.url;
  }
}
