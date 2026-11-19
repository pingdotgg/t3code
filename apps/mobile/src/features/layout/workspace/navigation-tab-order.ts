import { msg } from "gt-react-native";

export const NAVIGATION_TAB_ORDER = [
  "threads",
  "pullRequests",
  "issues",
  "workflows",
  "usage",
] as const;
export type NavigationTab = (typeof NAVIGATION_TAB_ORDER)[number];

const SHARED_SLOT_TABS = ["pullRequests", "issues"] as const;
export type SharedSlotTab = (typeof SHARED_SLOT_TABS)[number];

export function isSharedSlotTab(value: unknown): value is SharedSlotTab {
  return SHARED_SLOT_TABS.some((tab) => tab === value);
}

/**
 * Pull requests and issues share one slot in the tab bar. The open one holds it, or else the one
 * opened last; this returns the other, which the bar leaves out.
 */
export function sharedSlotAbsentee(selected: NavigationTab, last: unknown): SharedSlotTab {
  const holder = isSharedSlotTab(selected) ? selected : last === "issues" ? last : "pullRequests";
  return holder === "issues" ? "pullRequests" : "issues";
}

export function navigationCustomizationAvailable(
  registeredSections: number = NAVIGATION_TAB_ORDER.length - 1,
) {
  return registeredSections > 4;
}

export const NAVIGATION_TAB_LABELS: Readonly<Record<NavigationTab, string>> = {
  threads: msg("Threads", { $context: "navigation tab, list of chat threads" }),
  pullRequests: msg("Pulls", { $context: "navigation tab, pull requests" }),
  issues: msg("Issues", { $context: "navigation tab, issues from an issue tracker" }),
  workflows: msg("Workflows", { $context: "navigation tab, durable workflow runs" }),
  usage: msg("Usage", { $context: "navigation tab, provider usage limits" }),
};

function isNavigationTab(value: unknown): value is NavigationTab {
  return NAVIGATION_TAB_ORDER.some((tab) => tab === value);
}

/** Complete older preferences without losing their order or retaining removed sections. */
export function resolveNavigationTabOrder(saved?: readonly unknown[]): readonly NavigationTab[] {
  if (!saved?.length) return NAVIGATION_TAB_ORDER;
  return [...new Set([...saved.filter(isNavigationTab), ...NAVIGATION_TAB_ORDER])];
}

export function moveNavigationTab(
  saved: readonly unknown[] | undefined,
  tab: NavigationTab,
  position: number,
): readonly NavigationTab[] {
  const order = [...resolveNavigationTabOrder(saved)];
  const from = order.indexOf(tab);
  const to = Math.max(0, Math.min(order.length - 1, position));
  order.splice(from, 1);
  order.splice(to, 0, tab);
  return order;
}

export function resolveHiddenNavigationTabs(saved?: readonly unknown[]): readonly NavigationTab[] {
  return [...new Set(saved?.filter(isNavigationTab) ?? [])];
}

export function toggleNavigationTabVisibility(
  saved: readonly unknown[] | undefined,
  tab: NavigationTab,
) {
  const hidden = resolveHiddenNavigationTabs(saved);
  return hidden.includes(tab) ? hidden.filter((candidate) => candidate !== tab) : [...hidden, tab];
}

export function enabledNavigationTabs(saved?: readonly unknown[], hidden?: readonly unknown[]) {
  const excluded = resolveHiddenNavigationTabs(hidden);
  return resolveNavigationTabOrder(saved).filter((tab) => !excluded.includes(tab));
}

export function visibleNavigationTabs(
  saved?: readonly unknown[],
  hidden?: readonly unknown[],
  capacity = 4,
) {
  return enabledNavigationTabs(saved, hidden).slice(0, capacity);
}

export function overflowNavigationTabs(saved?: readonly unknown[], hidden?: readonly unknown[]) {
  return enabledNavigationTabs(saved, hidden).slice(4);
}

export function selectedNavigationTab(
  saved: readonly unknown[] | undefined,
  selected: NavigationTab,
  settingsOpen: boolean,
  hidden?: readonly unknown[],
  capacity = 4,
): NavigationTab | "settings" {
  return settingsOpen || !visibleNavigationTabs(saved, hidden, capacity).includes(selected)
    ? "settings"
    : selected;
}

export function resolveSelectedNavigationTab(
  saved: readonly unknown[] | undefined,
  hidden: readonly unknown[] | undefined,
  selected: NavigationTab,
) {
  const enabled = enabledNavigationTabs(saved, hidden);
  return enabled.includes(selected) ? selected : enabled[0];
}
