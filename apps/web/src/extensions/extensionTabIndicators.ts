import { resourceKey, type ViewRecord } from "@t3tools/extension-sdk/contracts";
import type { ViewTabIndicators } from "@t3tools/extension-sdk/host";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Tab indicators extension views publish through
 * `ViewSession.setTabIndicators`, keyed like the right-panel surface id so
 * the tab strip can read them without owning the view. The mounted surface
 * writes on every host notification that changes them and clears on unmount.
 */
const indicators = new Map<string, ViewTabIndicators>();
const listeners = new Set<() => void>();

export function extensionTabKey(record: Pick<ViewRecord, "surfaceId" | "context">): string {
  return `${record.surfaceId}\n${resourceKey(record.context.resource)}`;
}

const sameIndicators = (left: ViewTabIndicators | undefined, right: ViewTabIndicators | null) =>
  left?.pageUrl === right?.pageUrl &&
  left?.faviconDataUrl === right?.faviconDataUrl &&
  left?.audio === right?.audio &&
  left?.badge?.kind === right?.badge?.kind &&
  left?.badge?.count === right?.badge?.count;

export function setExtensionTabIndicators(key: string, next: ViewTabIndicators | null): void {
  const current = indicators.get(key);
  if (sameIndicators(current, next)) return;
  if (next === null) indicators.delete(key);
  else indicators.set(key, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useExtensionTabIndicators(key: string): ViewTabIndicators | null {
  const get = useCallback(() => indicators.get(key) ?? null, [key]);
  return useSyncExternalStore(subscribe, get, get);
}
