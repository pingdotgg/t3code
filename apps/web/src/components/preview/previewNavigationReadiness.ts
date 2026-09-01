import {
  isPreviewGatewayFailureReason,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationRequest,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { isCurrentPreviewRuntimeTab } from "~/browser/previewRuntimeTabId";
import { readThreadPreviewState } from "~/previewStateStore";

import { previewBridge } from "./previewBridge";
import {
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationTargetUnavailableError,
  PreviewGatewayNavigationError,
} from "./previewAutomationErrors";

const READ_PREVIEW_GATEWAY_ERROR_EXPRESSION = `(() => {
  const meta = document.querySelector('meta[name="t3-preview-gateway-error"]');
  return meta ? { reason: meta.getAttribute("content"), port: meta.getAttribute("data-port") } : null;
})()`;

async function throwIfPreviewGatewayFailed(runtimeTabId: string): Promise<void> {
  if (!previewBridge) return;
  const value = await previewBridge.automation.evaluate(runtimeTabId, {
    expression: READ_PREVIEW_GATEWAY_ERROR_EXPRESSION,
  });
  if (typeof value !== "object" || value === null || !("reason" in value)) return;
  const reason = value.reason;
  if (!isPreviewGatewayFailureReason(reason)) return;
  const rawPort = "port" in value ? value.port : undefined;
  const parsedPort = typeof rawPort === "string" ? Number(rawPort) : rawPort;
  const port =
    typeof parsedPort === "number" &&
    Number.isInteger(parsedPort) &&
    parsedPort > 0 &&
    parsedPort < 65_536
      ? parsedPort
      : undefined;
  throw new PreviewGatewayNavigationError({ reason, ...(port === undefined ? {} : { port }) });
}

export function assertPreviewRuntimeCurrent(
  threadRef: ScopedThreadRef,
  tabId: string,
  runtimeTabId: string,
  request: Pick<PreviewAutomationRequest, "operation" | "requestId">,
) {
  const state = readThreadPreviewState(threadRef);
  if (
    state.sessions[tabId] &&
    isCurrentPreviewRuntimeTab(threadRef, state.serverEpoch, tabId, runtimeTabId)
  ) {
    return state;
  }
  throw new PreviewAutomationTargetUnavailableError({
    requestId: request.requestId,
    operation: request.operation,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    tabId,
    bridgeAvailable: Boolean(previewBridge),
  });
}

export async function waitForNavigationReadiness(
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  runtimeTabId: string,
  operation: PreviewAutomationRequest["operation"],
  readiness: PreviewAutomationNavigateInput["readiness"],
  timeoutMs: number,
  gatewayExpected = false,
): Promise<void> {
  const targetReadiness = readiness ?? "load";
  if (!previewBridge) return;
  assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, { operation, requestId });
  if (targetReadiness === "none") return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, { operation, requestId });
    if (targetReadiness === "domContentLoaded") {
      const readyState = await previewBridge.automation.evaluate(runtimeTabId, {
        expression: "document.readyState",
      });
      if (readyState === "interactive" || readyState === "complete") {
        if (gatewayExpected) await throwIfPreviewGatewayFailed(runtimeTabId);
        return;
      }
    } else {
      const status = await previewBridge.automation.status(runtimeTabId);
      if (status.available && !status.loading) {
        if (gatewayExpected) await throwIfPreviewGatewayFailed(runtimeTabId);
        return;
      }
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new PreviewAutomationNavigationTimeoutError({
    requestId,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    tabId,
    readiness: targetReadiness,
    timeoutMs,
  });
}
