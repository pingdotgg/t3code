import { useAtomValue } from "@effect/atom-react";
import { useSyncExternalStore } from "react";
import type { EnvironmentId, PreviewRuntime, PreviewSessionSnapshot } from "@t3tools/contracts";

import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  if (!readEnvironmentSupportsServerBrowser(environmentId)) return undefined;
  if (
    isPreviewSupportedInRuntime() &&
    environmentId !== appAtomRegistry.get(primaryEnvironmentIdAtom)
  ) {
    return undefined;
  }
  return "server";
}

export function alternatePreviewRuntime(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  serverBrowser: boolean,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): PreviewRuntime | null {
  if (!snapshot || !serverBrowser || !isPreviewSupportedInRuntime()) return null;
  if (environmentId === primaryEnvironmentId) return null;
  return snapshot.runtime === "server" ? "desktop" : "server";
}

export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

type RuntimeSnapshot = Pick<
  PreviewSessionSnapshot,
  "threadId" | "tabId" | "runtime" | "headless" | "automationOwner"
>;

/** The desktop app hosts this server tab, in a panel `<webview>` or a background window. */
function desktopHostsServerTab(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: RuntimeSnapshot | null | undefined,
): boolean {
  return (
    isElectron &&
    snapshot?.runtime === "server" &&
    !snapshot.headless &&
    primaryEnvironmentId !== null &&
    environmentId === primaryEnvironmentId
  );
}

// Fixed when a tab first appears, until T3 is on screen again: moving a page between hosts replaces it.
let backgroundHostedTabs = new Map<string, boolean>();
const hostingListeners = new Set<() => void>();

// Its window takes focus when T3 is shown again. Background tabs then move to panel webviews, where
// every desktop tool works, and a new map makes memoized callers look again.
const returnBackgroundTabsToPanel = () => {
  if (![...backgroundHostedTabs.values()].some(Boolean)) return;
  backgroundHostedTabs = new Map([...backgroundHostedTabs.keys()].map((key) => [key, false]));
  for (const listener of hostingListeners) listener();
};

const subscribeBackgroundHosting = (listener: () => void) => {
  hostingListeners.add(listener);
  if (hostingListeners.size === 1) window.addEventListener("focus", returnBackgroundTabsToPanel);
  return () => {
    hostingListeners.delete(listener);
    if (hostingListeners.size === 0) {
      window.removeEventListener("focus", returnBackgroundTabsToPanel);
    }
  };
};

export type BackgroundHosting = ReadonlyMap<string, boolean>;

export const readBackgroundHosting = (): BackgroundHosting => backgroundHostedTabs;

export function useBackgroundHosting(): BackgroundHosting {
  return useSyncExternalStore(subscribeBackgroundHosting, readBackgroundHosting);
}

/**
 * A panel `<webview>` created while the app window is hidden or minimized never paints, so an
 * agent tab that appears then runs in a never-shown desktop window and the panel streams it.
 * `hosting` is the map from `useBackgroundHosting`, passed so memoized callers recompute.
 */
export function hostsServerTabInBackground(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: RuntimeSnapshot | null | undefined,
  hosting: BackgroundHosting,
): boolean {
  if (
    !snapshot ||
    snapshot.automationOwner === undefined ||
    !desktopHostsServerTab(environmentId, primaryEnvironmentId, snapshot)
  ) {
    return false;
  }
  const key = `${environmentId}\u0000${snapshot.threadId}\u0000${snapshot.tabId}`;
  const decided = backgroundHostedTabs.get(key) ?? hosting.get(key);
  if (decided !== undefined) return decided;
  const background = window.desktopBridge?.getWindowShown?.() === false;
  backgroundHostedTabs.set(key, background);
  return background;
}

export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: RuntimeSnapshot | null | undefined,
  hosting: BackgroundHosting,
): boolean {
  return (
    desktopHostsServerTab(environmentId, primaryEnvironmentId, snapshot) &&
    !hostsServerTabInBackground(environmentId, primaryEnvironmentId, snapshot, hosting)
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot: RuntimeSnapshot | null | undefined,
): boolean {
  return rendersServerTabNatively(
    environmentId,
    useAtomValue(primaryEnvironmentIdAtom),
    snapshot,
    useBackgroundHosting(),
  );
}
