import { useAtomValue } from "@effect/atom-react";
import { useEffect, useSyncExternalStore } from "react";
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

// Fixed when a tab first appears, until someone views it with T3 on screen: moving a page between
// hosts replaces it, so a tab nobody looks at keeps its live page in the background window.
let backgroundHostedTabs = new Map<string, boolean>();
const hostingListeners = new Set<() => void>();

const hostingKey = (environmentId: EnvironmentId, snapshot: RuntimeSnapshot) =>
  `${environmentId}\u0000${snapshot.threadId}\u0000${snapshot.tabId}`;

// A new map makes memoized callers look again.
const returnTabToPanel = (key: string) => {
  if (backgroundHostedTabs.get(key) !== true) return;
  backgroundHostedTabs = new Map(backgroundHostedTabs).set(key, false);
  for (const listener of hostingListeners) listener();
};

const subscribeBackgroundHosting = (listener: () => void) => {
  hostingListeners.add(listener);
  return () => {
    hostingListeners.delete(listener);
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
  const key = hostingKey(environmentId, snapshot);
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

/** For the tab the panel shows: a background tab moves into the panel once T3 has focus. */
export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot: RuntimeSnapshot | null | undefined,
): boolean {
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const hosting = useBackgroundHosting();
  const background = hostsServerTabInBackground(
    environmentId,
    primaryEnvironmentId,
    snapshot,
    hosting,
  );
  const backgroundKey = background && snapshot ? hostingKey(environmentId, snapshot) : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the viewed tab into the panel when the app window has focus, which React does not track
  useEffect(() => {
    if (backgroundKey === null) return;
    const moveToPanel = () => returnTabToPanel(backgroundKey);
    if (document.hasFocus()) moveToPanel();
    window.addEventListener("focus", moveToPanel);
    return () => window.removeEventListener("focus", moveToPanel);
  }, [backgroundKey]);
  return desktopHostsServerTab(environmentId, primaryEnvironmentId, snapshot) && !background;
}
