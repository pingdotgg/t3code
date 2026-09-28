import {
  type PreviewAutomationNavigateInput,
  type PreviewAutomationRequest,
  type ScopedThreadRef,
  PreviewAutomationManagedTargetAuthError,
} from "@t3tools/contracts";
import {
  isNetworkIdleSample,
  NETWORK_IDLE_SAMPLE_EXPRESSION,
  resolveNetworkIdleQuietMs,
} from "@t3tools/shared/previewNetworkIdle";

import { isCurrentPreviewRuntimeTab } from "~/browser/previewRuntimeTabId";
import { readThreadPreviewState } from "~/previewStateStore";

import { previewBridge } from "./previewBridge";
import {
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationTargetUnavailableError,
} from "./previewAutomationErrors";
import type { ManagedPreviewTarget } from "./previewManagedTarget";

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

export async function withCurrentPreviewRuntime<T>(
  threadRef: ScopedThreadRef,
  tabId: string,
  runtimeTabId: string,
  request: Pick<PreviewAutomationRequest, "operation" | "requestId">,
  operation: () => Promise<T>,
): Promise<T> {
  assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, request);
  const result = await operation();
  assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, request);
  return result;
}

export async function waitForNavigationReadiness(
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  runtimeTabId: string,
  operation: PreviewAutomationRequest["operation"],
  readiness: PreviewAutomationNavigateInput["readiness"],
  timeoutMs: number,
): Promise<void> {
  const requestedReadiness = readiness ?? "load";
  const bridge = previewBridge;
  if (!bridge) return;
  assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, { operation, requestId });
  if (requestedReadiness === "none") return;
  const targetReadiness = requestedReadiness;
  const deadline = Date.now() + timeoutMs;
  const quietMs = resolveNetworkIdleQuietMs();
  while (Date.now() <= deadline) {
    if (targetReadiness === "domContentLoaded") {
      const readyState = await withCurrentPreviewRuntime(
        threadRef,
        tabId,
        runtimeTabId,
        { operation, requestId },
        () =>
          bridge.automation.evaluate(runtimeTabId, {
            expression: "document.readyState",
          }),
      );
      if (readyState === "interactive" || readyState === "complete") return;
    } else if (targetReadiness === "networkIdle") {
      const status = await withCurrentPreviewRuntime(
        threadRef,
        tabId,
        runtimeTabId,
        { operation, requestId },
        () => bridge.automation.status(runtimeTabId),
      );
      const sample = await withCurrentPreviewRuntime(
        threadRef,
        tabId,
        runtimeTabId,
        { operation, requestId },
        () =>
          bridge.automation.evaluate(runtimeTabId, {
            expression: NETWORK_IDLE_SAMPLE_EXPRESSION,
          }),
      );
      const parsed =
        typeof sample === "object" && sample !== null
          ? (sample as {
              readyState?: unknown;
              msSinceLastResource?: unknown;
              nowMs?: unknown;
            })
          : null;
      if (
        parsed &&
        typeof parsed.readyState === "string" &&
        (parsed.msSinceLastResource === null || typeof parsed.msSinceLastResource === "number") &&
        typeof parsed.nowMs === "number" &&
        isNetworkIdleSample(
          {
            readyState: parsed.readyState,
            loadingFlag: Boolean(status.available && status.loading),
            msSinceLastResource:
              typeof parsed.msSinceLastResource === "number" || parsed.msSinceLastResource === null
                ? parsed.msSinceLastResource
                : null,
            nowMs: parsed.nowMs,
          },
          quietMs,
        )
      ) {
        return;
      }
    } else {
      const status = await withCurrentPreviewRuntime(
        threadRef,
        tabId,
        runtimeTabId,
        { operation, requestId },
        () => bridge.automation.status(runtimeTabId),
      );
      if (status.available && !status.loading) return;
    }
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 50);
    });
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

interface ManagedPreviewReadinessProbe {
  readonly status: "authenticated" | "unauthenticated" | "unavailable" | "origin-mismatch";
  readonly pairingPage: boolean;
  readonly appReady: boolean;
  readonly reason?: "missing" | "expired" | "revoked" | "invalid";
}

const readManagedPreviewReadinessProbe = (value: unknown): ManagedPreviewReadinessProbe | null => {
  if (typeof value !== "object" || value === null) return null;
  const status = "status" in value ? value.status : undefined;
  const pairingPage = "pairingPage" in value ? value.pairingPage : undefined;
  const appReady = "appReady" in value ? value.appReady : undefined;
  const reason = "reason" in value ? value.reason : undefined;
  if (
    (status !== "authenticated" &&
      status !== "unauthenticated" &&
      status !== "unavailable" &&
      status !== "origin-mismatch") ||
    typeof pairingPage !== "boolean" ||
    typeof appReady !== "boolean" ||
    (reason !== undefined &&
      reason !== "missing" &&
      reason !== "expired" &&
      reason !== "revoked" &&
      reason !== "invalid")
  ) {
    return null;
  }
  return {
    status,
    pairingPage,
    appReady,
    ...(reason === undefined ? {} : { reason }),
  };
};

const managedReadinessExpression = (target: ManagedPreviewTarget): string => {
  const allowedOrigins = JSON.stringify(target.expectedOrigins);
  return `(async()=>{const allowedOrigins=${allowedOrigins};const pairingPage=location.pathname==="/pair"||location.pathname==="/pair/";if(!allowedOrigins.includes(location.origin))return{status:"origin-mismatch",pairingPage,appReady:false};try{const response=await fetch(new URL("/api/auth/session",location.origin),{cache:"no-store",credentials:"include",headers:{accept:"application/json"},signal:AbortSignal.timeout(750)});if(!response.ok)return{status:"unavailable",pairingPage,appReady:false};const auth=await response.json();return{status:auth?.authenticated===true?"authenticated":"unauthenticated",pairingPage,appReady:(document.readyState==="interactive"||document.readyState==="complete")&&Boolean(document.body?.childElementCount),reason:auth?.unauthenticatedReason}}catch{return{status:"unavailable",pairingPage,appReady:false}}})()`;
};

export async function waitForManagedPreviewReadiness(input: {
  readonly threadRef: ScopedThreadRef;
  readonly request: Pick<PreviewAutomationRequest, "operation" | "requestId">;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly target: ManagedPreviewTarget;
  readonly targetUrl?: string;
  readonly timeoutMs: number;
  readonly recoverPairingPage?: boolean;
}): Promise<void> {
  const bridge = previewBridge;
  if (!bridge) {
    throw new PreviewAutomationManagedTargetAuthError({
      operation: input.request.operation,
      environmentId: input.threadRef.environmentId,
      threadId: input.threadRef.threadId,
      requestId: input.request.requestId,
      tabId: input.tabId,
      timeoutMs: input.timeoutMs,
      reason: "bootstrap-failed",
    });
  }

  const timeoutMs = Math.min(input.timeoutMs, 15_000);
  const deadline = Date.now() + timeoutMs;
  const expression = managedReadinessExpression(input.target);
  const targetIsPairingPage = (() => {
    if (!input.targetUrl) return false;
    try {
      const pathname = new URL(input.targetUrl).pathname;
      return pathname === "/pair" || pathname === "/pair/";
    } catch {
      return false;
    }
  })();
  let recoveredPairingPage = false;

  while (Date.now() < deadline) {
    const probeValue = await withCurrentPreviewRuntime(
      input.threadRef,
      input.tabId,
      input.runtimeTabId,
      input.request,
      () =>
        bridge.automation.evaluate(input.runtimeTabId, {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }),
    );
    const probe = readManagedPreviewReadinessProbe(probeValue);
    if (probe?.status === "origin-mismatch") {
      throw new PreviewAutomationManagedTargetAuthError({
        operation: input.request.operation,
        environmentId: input.threadRef.environmentId,
        threadId: input.threadRef.threadId,
        requestId: input.request.requestId,
        tabId: input.tabId,
        timeoutMs,
        reason: "target-origin-mismatch",
      });
    }
    if (probe?.reason === "revoked") {
      throw new PreviewAutomationManagedTargetAuthError({
        operation: input.request.operation,
        environmentId: input.threadRef.environmentId,
        threadId: input.threadRef.threadId,
        requestId: input.request.requestId,
        tabId: input.tabId,
        timeoutMs,
        reason: "session-revoked",
      });
    }
    if (probe?.reason === "expired") {
      throw new PreviewAutomationManagedTargetAuthError({
        operation: input.request.operation,
        environmentId: input.threadRef.environmentId,
        threadId: input.threadRef.threadId,
        requestId: input.request.requestId,
        tabId: input.tabId,
        timeoutMs,
        reason: "session-expired",
      });
    }
    if (probe?.reason === "invalid") {
      throw new PreviewAutomationManagedTargetAuthError({
        operation: input.request.operation,
        environmentId: input.threadRef.environmentId,
        threadId: input.threadRef.threadId,
        requestId: input.request.requestId,
        tabId: input.tabId,
        timeoutMs,
        reason: "invalid-session",
      });
    }
    if (probe?.pairingPage) {
      if (
        input.recoverPairingPage &&
        !recoveredPairingPage &&
        !targetIsPairingPage &&
        input.targetUrl
      ) {
        recoveredPairingPage = true;
        await withCurrentPreviewRuntime(
          input.threadRef,
          input.tabId,
          input.runtimeTabId,
          input.request,
          () => bridge.navigate(input.runtimeTabId, input.targetUrl!),
        );
      } else {
        throw new PreviewAutomationManagedTargetAuthError({
          operation: input.request.operation,
          environmentId: input.threadRef.environmentId,
          threadId: input.threadRef.threadId,
          requestId: input.request.requestId,
          tabId: input.tabId,
          timeoutMs,
          reason: "pairing-required",
        });
      }
    }
    if (probe?.status === "authenticated" && probe.appReady && !probe.pairingPage) return;
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 50));
  }

  throw new PreviewAutomationManagedTargetAuthError({
    operation: input.request.operation,
    environmentId: input.threadRef.environmentId,
    threadId: input.threadRef.threadId,
    requestId: input.request.requestId,
    tabId: input.tabId,
    timeoutMs,
    reason: "readiness-timeout",
  });
}
