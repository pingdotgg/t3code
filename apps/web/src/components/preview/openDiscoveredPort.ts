import type { DiscoveredLocalServer, ScopedThreadRef } from "@t3tools/contracts";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { ensureEnvironmentApi } from "~/environmentApi";
import { usePreviewStateStore } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { openPreviewSession } from "./openPreviewSession";

export async function openDiscoveredPort(input: {
  readonly threadRef: ScopedThreadRef;
  readonly port: DiscoveredLocalServer;
}): Promise<void> {
  const api = ensureEnvironmentApi(input.threadRef.environmentId);
  const resolvedUrl = resolveDiscoveredServerUrl(input.threadRef.environmentId, input.port.url);
  const previewState = usePreviewStateStore.getState();
  const snapshot = await openPreviewSession({
    previewApi: api.preview,
    threadRef: input.threadRef,
    url: resolvedUrl,
    applyServerSnapshot: previewState.applyServerSnapshot,
    rememberUrl: previewState.rememberUrl,
  });
  useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
}
