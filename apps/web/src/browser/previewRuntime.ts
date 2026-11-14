import { useAtomValue } from "@effect/atom-react";
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

// Fixed when a tab first appears: Electron cannot move a page between a window and a
// `<webview>`, so changing hosts later would reload it and lose the agent's live page.
const backgroundHostedTabs = new Map<string, boolean>();

/**
 * A panel `<webview>` created while the app window is hidden or minimized never paints, so an
 * agent tab that appears then runs in a never-shown desktop window and the panel streams it.
 */
export function hostsServerTabInBackground(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: RuntimeSnapshot | null | undefined,
): boolean {
  if (
    !snapshot ||
    snapshot.automationOwner === undefined ||
    !desktopHostsServerTab(environmentId, primaryEnvironmentId, snapshot)
  ) {
    return false;
  }
  const key = `${environmentId}\u0000${snapshot.threadId}\u0000${snapshot.tabId}`;
  const decided = backgroundHostedTabs.get(key);
  if (decided !== undefined) return decided;
  const background = window.desktopBridge?.getWindowShown?.() === false;
  backgroundHostedTabs.set(key, background);
  return background;
}

export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: RuntimeSnapshot | null | undefined,
): boolean {
  return (
    desktopHostsServerTab(environmentId, primaryEnvironmentId, snapshot) &&
    !hostsServerTabInBackground(environmentId, primaryEnvironmentId, snapshot)
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot: RuntimeSnapshot | null | undefined,
): boolean {
  return rendersServerTabNatively(environmentId, useAtomValue(primaryEnvironmentIdAtom), snapshot);
}
