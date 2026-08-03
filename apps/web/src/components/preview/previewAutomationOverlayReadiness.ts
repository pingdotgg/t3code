import { type PreviewAutomationRequest, type ScopedThreadRef } from "@t3tools/contracts";

import { previewBridge } from "./previewBridge";
import { PreviewAutomationOverlayTimeoutError } from "./previewAutomationErrors";
import { assertPreviewRuntimeCurrent } from "./previewNavigationReadiness";

export async function waitForDesktopOverlay(
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  runtimeTabId: string,
  operation: PreviewAutomationRequest["operation"],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, {
      operation,
      requestId,
    });
    if (state.desktopByTabId[tabId] && previewBridge) {
      const status = await previewBridge.automation.status(runtimeTabId);
      if (status.available) return;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(50, remainingMs)));
  }
  throw new PreviewAutomationOverlayTimeoutError({
    requestId,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    timeoutMs,
  });
}
