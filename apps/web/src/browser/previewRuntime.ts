import type { EnvironmentId, PreviewRuntime } from "@t3tools/contracts";

import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { readEnvironmentSupportsServerBrowser } from "~/state/entities";

/**
 * Where a new tab for this environment runs. An environment that hosts its own
 * browser gets server tabs from every client, so they outlive this device;
 * the desktop app's own environment keeps Electron tabs.
 */
export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  return readEnvironmentSupportsServerBrowser(environmentId) ? "server" : undefined;
}

/** Whether this client can open a browser tab for the environment at all. */
export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}
