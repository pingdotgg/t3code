"use client";

import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_AUTOMATION_OPERATIONS,
  EnvironmentId,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenAndSnapshotInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationResizeInput,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationOpenAndSnapshotResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationSnapshotInput,
  type PreviewAutomationPreflightInput,
  type PreviewAutomationPreflightResult,
  type PreviewAutomationTabsResult,
  type PreviewAutomationHost as PreviewAutomationHostState,
  type PreviewAutomationRequest,
  type PreviewAutomationStatus,
  type PreviewRenderedViewportSize,
  type PreviewViewportSetting,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Atom } from "effect/unstable/reactivity";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { resolveBrowserNavigationTarget } from "~/browser/browserTargetResolver";
import {
  readActiveBrowserRecordingTargets,
  readSavedBrowserRecordingTransfer,
  startBrowserRecording,
  stopBrowserRecording,
} from "~/browser/browserRecording";
import {
  resolveBrowserRecordingStopTarget,
  rewriteBrowserRecordingArtifactTabId,
  type BrowserRecordingStopTarget,
} from "~/browser/browserRecordingScope";
import {
  acquireBrowserSurfaceActivity,
  useBrowserSurfaceStore,
} from "~/browser/browserSurfaceStore";
import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { isElectron } from "~/env";
import { useEnvironmentConnectionEpoch, useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";
import {
  PreviewAutomationOperationError,
  PreviewAutomationOverlayTimeoutError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationViewportTimeoutError,
} from "./previewAutomationErrors";
import { openPreviewSession } from "./openPreviewSession";
import {
  PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS,
  explicitlySuppressesPreview,
  previewAutomationDefaultViewport,
  previewAutomationOpenNeedsOverlay,
  previewPresentationSettleDecision,
  shouldAutoShowPreviewForAutomationUse,
  shouldPresentPreview,
} from "./previewAutomationOpenReadiness";
import { resolveSnapshotBudgets } from "./previewSnapshotBudgets";

export const classifyPreviewPreflightTarget = (input: {
  readonly descriptorStatus: number | null;
  readonly appStatus: number | null;
  readonly origin: string;
  readonly environmentId: EnvironmentId | null;
  readonly expectedEnvironmentId: EnvironmentId | null;
}): Pick<PreviewAutomationPreflightResult, "target" | "recovery"> => {
  if (input.appStatus === null || input.descriptorStatus === null) {
    return {
      target: {
        requested: true,
        reachability: "unreachable",
        app: "unknown",
        origin: input.origin,
        environmentId: null,
        status: null,
      },
      recovery: {
        kind: "retry-target",
        message: "The target could not be reached by the collaborative browser.",
      },
    };
  }
  if (input.descriptorStatus !== 200 || input.environmentId === null) {
    return {
      target: {
        requested: true,
        reachability: "reachable",
        app: "not-t3-app",
        origin: input.origin,
        environmentId: input.environmentId,
        status: input.appStatus,
      },
      recovery: {
        kind: "configure-target",
        message: "The target is reachable but does not serve the expected T3 app.",
      },
    };
  }
  if (input.appStatus === 503) {
    return {
      target: {
        requested: true,
        reachability: "reachable",
        app: "not-configured",
        origin: input.origin,
        environmentId: input.environmentId,
        status: input.appStatus,
      },
      recovery: {
        kind: "configure-target",
        message: "The target is reachable but has no configured T3 static directory or dev URL.",
      },
    };
  }
  if (input.appStatus !== 200) {
    return {
      target: {
        requested: true,
        reachability: "reachable",
        app: "not-t3-app",
        origin: input.origin,
        environmentId: input.environmentId,
        status: input.appStatus,
      },
      recovery: {
        kind: "configure-target",
        message: "The target is reachable but does not serve the expected T3 app.",
      },
    };
  }
  if (input.expectedEnvironmentId !== null && input.environmentId !== input.expectedEnvironmentId) {
    return {
      target: {
        requested: true,
        reachability: "reachable",
        app: "expected-t3-app",
        origin: input.origin,
        environmentId: input.environmentId,
        status: input.appStatus,
      },
      recovery: {
        kind: "resolve-environment-mismatch",
        message:
          "The target serves a different T3 environment; pairing is blocked until the target and environment are aligned.",
      },
    };
  }
  return {
    target: {
      requested: true,
      reachability: "reachable",
      app: "expected-t3-app",
      origin: input.origin,
      environmentId: input.environmentId,
      status: input.appStatus,
    },
    recovery: {
      kind: "pair-after-preflight",
      message:
        "The target is the expected T3 environment. Pair only after this preflight and do not reuse the probe URL as a pairing token.",
    },
  };
};

export const classifyPreviewPreflightProbe = (input: {
  readonly requestedOrigin: string;
  readonly finalOrigin: string | null;
  readonly descriptorStatus: number | null;
  readonly appStatus: number | null;
  readonly environmentId: EnvironmentId | null;
  readonly expectedEnvironmentId: EnvironmentId | null;
}): Pick<PreviewAutomationPreflightResult, "target" | "recovery"> => {
  if (input.finalOrigin !== input.requestedOrigin) {
    return {
      target: {
        requested: true,
        reachability: "reachable",
        app: "unknown",
        origin: input.finalOrigin,
        environmentId: null,
        status: null,
      },
      recovery: {
        kind: "retry-target",
        message:
          "The target redirected to a different origin during preflight; pairing is blocked until the requested target is reached directly.",
      },
    };
  }
  return classifyPreviewPreflightTarget({
    descriptorStatus: input.descriptorStatus,
    appStatus: input.appStatus,
    origin: input.requestedOrigin,
    environmentId: input.environmentId,
    expectedEnvironmentId: input.expectedEnvironmentId,
  });
};
import { createPreviewAutomationRequestConsumerAtom } from "./previewAutomationRequestConsumer";
import { createPreviewAutomationClientId } from "./previewAutomationClientId";
import { prepareManagedPreviewTarget, type ManagedPreviewTarget } from "./previewManagedTarget";
import {
  needsPreviewAutomationSessionSync,
  resolvePreviewAutomationOpenTab,
  resolvePreviewAutomationTarget,
} from "./previewAutomationTarget";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import {
  type HostDeadlineMs,
  resolveHostDeadlineMs,
  waitForHostReadiness,
} from "./previewAutomationHostBudget";
import { isPreviewViewportReady } from "./previewViewportReadiness";
import {
  beginPreviewViewportMutation,
  finishPreviewViewportMutation,
  shouldRollbackPreviewViewport,
} from "./previewViewportRollback";
import {
  assertPreviewRuntimeCurrent,
  withCurrentPreviewRuntime,
  waitForManagedPreviewReadiness,
  waitForNavigationReadiness,
} from "./previewNavigationReadiness";

const waitForPreviewPresentation = async (runtimeTabId: string): Promise<void> => {
  const startedAt = Date.now();
  for (;;) {
    const presentation = useBrowserSurfaceStore.getState().byTabId[runtimeTabId];
    const decision = previewPresentationSettleDecision({
      visible: presentation?.visible ?? false,
      claimed: presentation?.owner != null,
      elapsedMs: Date.now() - startedAt,
      timeoutMs: PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS,
    });
    if (decision === "done") return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
  }
};

const waitForDesktopOverlay = async (
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  runtimeTabId: string,
  operation: PreviewAutomationRequest["operation"],
  deadlineMs: HostDeadlineMs,
): Promise<void> => {
  const waitBudgetMs = Math.max(0, deadlineMs - Date.now());
  const ready = await waitForHostReadiness(deadlineMs, async () => {
    const state = assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, {
      operation,
      requestId,
    });
    const bridge = previewBridge;
    if (state.desktopByTabId[tabId] && bridge) {
      const status = await withCurrentPreviewRuntime(
        threadRef,
        tabId,
        runtimeTabId,
        { operation, requestId },
        () => bridge.automation.status(runtimeTabId),
      );
      if (status.available) return true;
    }
    return false;
  });
  if (ready) return;
  throw new PreviewAutomationOverlayTimeoutError({
    requestId,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    timeoutMs: waitBudgetMs,
  });
};

interface ExecutablePreviewWebview extends Element {
  readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

const findPreviewWebview = (tabId: string): ExecutablePreviewWebview | null =>
  Array.from(document.querySelectorAll<ExecutablePreviewWebview>("webview[data-preview-tab]")).find(
    (candidate) => candidate.getAttribute("data-preview-tab") === tabId,
  ) ?? null;

const readWebviewViewport = async (
  webview: ExecutablePreviewWebview,
): Promise<PreviewRenderedViewportSize | null> => {
  const value = await webview.executeJavaScript(
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as { readonly width?: unknown; readonly height?: unknown };
  return typeof width === "number" &&
    Number.isInteger(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isInteger(height) &&
    height > 0
    ? { width, height }
    : null;
};

const readRenderedViewport = async (tabId: string): Promise<PreviewRenderedViewportSize | null> => {
  const webview = findPreviewWebview(tabId);
  if (!webview) return null;
  return await readWebviewViewport(webview);
};

const readDeclaredViewport = (
  webview: ExecutablePreviewWebview | null,
): PreviewRenderedViewportSize | null => {
  const width = Number(webview?.getAttribute("data-preview-css-width"));
  const height = Number(webview?.getAttribute("data-preview-css-height"));
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    ? { width, height }
    : null;
};

const waitForRenderedViewport = async (
  tabId: string,
  setting: PreviewViewportSetting,
  timeoutMs: number,
  context: {
    readonly requestId: PreviewAutomationRequest["requestId"];
    readonly environmentId: EnvironmentId;
    readonly threadId: PreviewAutomationRequest["threadId"];
  },
): Promise<PreviewRenderedViewportSize> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const webview = findPreviewWebview(tabId);
      const appliedSettingKey = webview?.getAttribute("data-preview-viewport-key") ?? null;
      const declaredViewport = readDeclaredViewport(webview);
      const renderedViewport = webview ? await readWebviewViewport(webview) : null;
      if (
        renderedViewport &&
        isPreviewViewportReady({
          setting,
          appliedSettingKey,
          declaredViewport,
          renderedViewport,
        })
      ) {
        return renderedViewport;
      }
    } catch {
      // Registration and navigation can transiently replace the guest while
      // React applies the server snapshot. Retry until the operation deadline.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new PreviewAutomationViewportTimeoutError({
    ...context,
    tabId,
    timeoutMs,
  });
};

export const readPreviewAutomationStatus = async (
  threadRef: ScopedThreadRef,
  requestedTabId: string | null,
): Promise<PreviewAutomationStatus> => {
  const state = readThreadPreviewState(threadRef);
  const { snapshot, tabId } = resolvePreviewAutomationTarget(state, requestedTabId);
  const runtimeTabId = tabId ? previewRuntimeTabId(threadRef, state.serverEpoch, tabId) : null;
  const visible = runtimeTabId
    ? (useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible ?? false)
    : false;
  const viewportSetting = snapshot ? (snapshot.viewport ?? FILL_PREVIEW_VIEWPORT) : undefined;
  const viewport = runtimeTabId ? await readRenderedViewport(runtimeTabId).catch(() => null) : null;
  const viewportStatus = {
    ...(viewportSetting === undefined ? {} : { viewportSetting }),
    ...(viewport === null ? {} : { viewport }),
  };
  if (runtimeTabId && tabId && previewBridge && state.desktopByTabId[tabId]) {
    const status = await previewBridge.automation.status(runtimeTabId);
    return { ...status, tabId, visible, ...viewportStatus };
  }
  const navStatus = snapshot?.navStatus;
  return {
    available: Boolean(previewBridge?.automation),
    visible,
    tabId,
    url: navStatus && navStatus._tag !== "Idle" ? navStatus.url : null,
    title: navStatus && navStatus._tag !== "Idle" ? navStatus.title : null,
    loading: navStatus?._tag === "Loading",
    ...viewportStatus,
  };
};

const raiseAtomCommandFailure = (result: Parameters<typeof squashAtomCommandFailure>[0]): never => {
  throw squashAtomCommandFailure(result);
};

const raisePreviewAutomationHostError = (
  error: PreviewAutomationRecordingNotActiveError,
): never => {
  throw error;
};

export function PreviewAutomationHosts() {
  const { environments } = useEnvironments();
  return (
    <>
      {/*
       * Host lifetime follows the desktop runtime's environment connections,
       * not the routed thread. This keeps background threads automatable and
       * lets the subscription runtime own reconnects for every saved target.
       * Browser-served clients still register with zero supported operations,
       * so routing can report an explicitly unsupported host instead of
       * attempting to send it a request it cannot consume.
       */}
      {environments.map((environment) => (
        <PreviewAutomationEnvironmentHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </>
  );
}

function PreviewAutomationEnvironmentHost(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  // Saved environments are listed before their websocket connects, and the host
  // subscription fails terminally if it is created first. Gate on the live
  // connection and remount when it is replaced so a reconnect re-registers.
  const connectionEpoch = useEnvironmentConnectionEpoch(environmentId);
  if (connectionEpoch === null) return null;
  return isElectron && previewBridge?.automation ? (
    <PreviewAutomationHost key={connectionEpoch} environmentId={environmentId} />
  ) : (
    <PreviewAutomationUnavailableHost key={connectionEpoch} environmentId={environmentId} />
  );
}

function PreviewAutomationUnavailableHost(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const [automationClientId] = useState(createPreviewAutomationClientId);
  const unavailableAutomationHost = useMemo<PreviewAutomationHostState>(
    () => ({
      clientId: automationClientId,
      environmentId,
      supportedOperations: [],
    }),
    [automationClientId, environmentId],
  );
  const automationRequestsAtom = previewEnvironment.automationRequests({
    environmentId,
    input: unavailableAutomationHost,
  });
  useAtomValue(automationRequestsAtom);
  return null;
}

function PreviewAutomationHost(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const registry = useContext(RegistryContext);
  const [automationClientId] = useState(createPreviewAutomationClientId);
  const initialAutomationHost = useMemo<PreviewAutomationHostState>(
    () => ({
      clientId: automationClientId,
      environmentId,
      supportedOperations: [...PREVIEW_AUTOMATION_OPERATIONS],
    }),
    [automationClientId, environmentId],
  );
  const automationRequestsAtom = previewEnvironment.automationRequests({
    environmentId,
    input: initialAutomationHost,
  });
  const listPreviews = useAtomQueryRunner(previewEnvironment.list, {
    reportFailure: false,
  });
  const open = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const resize = useAtomCommand(previewEnvironment.resize, {
    reportFailure: false,
  });
  const respondToAutomation = useAtomCommand(
    previewEnvironment.respondToAutomation,
    "preview automation response",
  );
  const focusAutomationHost = useAtomCommand(
    previewEnvironment.focusAutomationHost,
    "preview automation host focus",
  );
  const [automationConnectionAtom] = useState(() => Atom.make<string | null>(null));
  const automationConnectionId = useAtomValue(automationConnectionAtom);
  const synchronizedThreadIdsRef = useRef(new Set<string>());
  const presentationSuppressedRuntimeTabsRef = useRef(new Map<string, Set<string>>());
  const managedTargetsByThreadRef = useRef(
    new Map<
      string,
      {
        readonly serverEpoch: string | null;
        readonly byTabId: Map<string, ManagedPreviewTarget>;
      }
    >(),
  );

  const handleRequest = useCallback(
    async (request: PreviewAutomationRequest): Promise<unknown> => {
      // Session sync and tab creation consume the same budget as overlay registration.
      const hostDeadlineMs = resolveHostDeadlineMs(request.timeoutMs);
      const threadRef: ScopedThreadRef = {
        environmentId,
        threadId: request.threadId,
      };
      const managedTargets = () => {
        const current = readThreadPreviewState(threadRef);
        const key = `${environmentId}\u0000${request.threadId}`;
        const existing = managedTargetsByThreadRef.current.get(key);
        if (existing?.serverEpoch === current.serverEpoch) {
          for (const [knownTabId, target] of existing.byTabId) {
            const session = current.sessions[knownTabId];
            if (!session) {
              existing.byTabId.delete(knownTabId);
              continue;
            }
            // A manual navigation away from the managed origins leaves the
            // session alive, so the entry would otherwise force managed
            // readiness against an unrelated origin. Drop it and treat the
            // tab as an ordinary unmanaged target.
            const url = session.navStatus._tag === "Idle" ? null : session.navStatus.url;
            if (url) {
              try {
                if (!target.expectedOrigins.includes(new URL(url).origin)) {
                  existing.byTabId.delete(knownTabId);
                }
              } catch {
                // Keep the entry when the URL cannot be parsed.
              }
            }
          }
          return existing.byTabId;
        }
        const replacement = { serverEpoch: current.serverEpoch, byTabId: new Map() };
        managedTargetsByThreadRef.current.set(key, replacement);
        return replacement.byTabId;
      };
      const waitForManagedTab = async (
        managedTabId: string,
        runtimeTabId: string,
        options?: { readonly targetUrl?: string; readonly recoverPairingPage?: boolean },
      ) => {
        const target = managedTargets().get(managedTabId);
        if (!target) return;
        await waitForManagedPreviewReadiness({
          threadRef,
          request,
          tabId: managedTabId,
          runtimeTabId,
          target,
          ...(options?.targetUrl === undefined ? {} : { targetUrl: options.targetUrl }),
          timeoutMs: request.timeoutMs,
          ...(options?.recoverPairingPage === undefined
            ? {}
            : { recoverPairingPage: options.recoverPairingPage }),
        });
      };
      let tabId = request.tabId ?? null;
      const browserActivity: { release?: () => void } = {};
      try {
        let state = readThreadPreviewState(threadRef);
        const needsSessionSync = needsPreviewAutomationSessionSync(
          state,
          request.tabId,
          synchronizedThreadIdsRef.current.has(request.threadId),
        );
        if (needsSessionSync) {
          const listTarget = {
            environmentId,
            input: { threadId: request.threadId },
          } as const;
          registry.refresh(previewEnvironment.list(listTarget));
          const result = await listPreviews(listTarget);
          if (result._tag === "Failure") {
            return raiseAtomCommandFailure(result);
          }
          reconcilePreviewServerSessions(threadRef, result.value);
          synchronizedThreadIdsRef.current.add(request.threadId);
          state = readThreadPreviewState(threadRef);
        }
        tabId = request.tabId ?? state.snapshot?.tabId ?? null;
        const unavailableTarget = {
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: request.threadId,
          tabId,
          bridgeAvailable: Boolean(previewBridge),
        };
        const requireReadyTab = async (verifyManagedTarget = true) => {
          const bridge = previewBridge;
          const readyTabId = tabId;
          if (!bridge || !readyTabId) {
            throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
          }
          const runtimeTabId = previewRuntimeTabId(
            threadRef,
            readThreadPreviewState(threadRef).serverEpoch,
            readyTabId,
          );
          await ensureClientSettingsHydrated();
          if (
            shouldAutoShowPreviewForAutomationUse({
              operation: request.operation,
              autoShowFloatingPreview: getClientSettings().browserAutoShowFloatingPreview,
              presentationSuppressed:
                presentationSuppressedRuntimeTabsRef.current
                  .get(request.threadId)
                  ?.has(runtimeTabId) ?? false,
            })
          ) {
            usePreviewMiniPlayerStore
              .getState()
              .open(threadRef, browserMiniPlayerSource(readyTabId));
          }
          browserActivity.release ??= acquireBrowserSurfaceActivity(runtimeTabId);
          await waitForDesktopOverlay(
            threadRef,
            request.requestId,
            readyTabId,
            runtimeTabId,
            request.operation,
            hostDeadlineMs,
          );
          if (verifyManagedTarget) {
            await waitForManagedTab(readyTabId, runtimeTabId);
          }
          return { bridge, tabId: readyTabId, runtimeTabId };
        };
        const applyPresentationIntent = async (
          input: PreviewAutomationOpenInput,
          activeTabId: string,
          activeRuntimeTabId: string,
        ): Promise<boolean> => {
          await ensureClientSettingsHydrated();
          const shouldPresent = shouldPresentPreview(
            input,
            getClientSettings().browserAutoShowFloatingPreview,
          );
          const suppressedTabs = presentationSuppressedRuntimeTabsRef.current.get(request.threadId);
          if (explicitlySuppressesPreview(input)) {
            if (suppressedTabs) {
              suppressedTabs.add(activeRuntimeTabId);
            } else {
              presentationSuppressedRuntimeTabsRef.current.set(
                request.threadId,
                new Set([activeRuntimeTabId]),
              );
            }
            const miniPlayerTabId = selectThreadPreviewMiniPlayerTabId(
              usePreviewMiniPlayerStore.getState().byThreadKey,
              threadRef,
            );
            if (miniPlayerTabId === activeTabId) {
              usePreviewMiniPlayerStore.getState().close(threadRef);
            }
          } else if (shouldPresent) {
            suppressedTabs?.delete(activeRuntimeTabId);
            if (suppressedTabs?.size === 0) {
              presentationSuppressedRuntimeTabsRef.current.delete(request.threadId);
            }
          }
          if (shouldPresent) {
            usePreviewMiniPlayerStore
              .getState()
              .open(threadRef, browserMiniPlayerSource(activeTabId));
            useRightPanelStore.getState().openBrowser(threadRef, activeTabId);
          }
          return shouldPresent;
        };
        switch (request.operation) {
          case "preflight": {
            const input = request.input as PreviewAutomationPreflightInput;
            const targetRequested = input.url !== undefined || input.target !== undefined;
            tabId = resolvePreviewAutomationOpenTab(
              state,
              request.tabId,
              input.reuseExistingTab ?? true,
            );
            const browserStatus = await readPreviewAutomationStatus(threadRef, tabId);
            const unselectedTabStatus =
              tabId === null && input.reuseExistingTab === false
                ? {
                    ...browserStatus,
                    tabId: null,
                    url: null,
                    title: null,
                    loading: false,
                  }
                : browserStatus;
            const makeResult = (
              target: PreviewAutomationPreflightResult["target"],
              recovery: PreviewAutomationPreflightResult["recovery"],
              status = unselectedTabStatus,
            ): PreviewAutomationPreflightResult => ({
              ...(status.tabId === null ? {} : { tabId: status.tabId }),
              browser: {
                supported: Boolean(previewBridge),
                available: Boolean(previewBridge),
                visible: status.visible,
                tabAttached: status.tabId !== null,
                tabId: status.tabId,
              },
              mcp: { credential: "valid" },
              target,
              recovery,
            });

            if (!previewBridge) {
              return makeResult(
                {
                  requested: targetRequested,
                  reachability: targetRequested ? "not-checked" : "not-requested",
                  app: targetRequested ? "unknown" : "not-requested",
                  origin: null,
                  environmentId: null,
                  status: null,
                },
                {
                  kind: "use-supported-browser",
                  message:
                    "This browser host is connected but does not support collaborative preview automation.",
                },
              );
            }

            if (!tabId && input.open !== true) {
              return makeResult(
                {
                  requested: targetRequested,
                  reachability: targetRequested ? "not-checked" : "not-requested",
                  app: targetRequested ? "unknown" : "not-requested",
                  origin: null,
                  environmentId: null,
                  status: null,
                },
                {
                  kind: "open-browser",
                  message:
                    "No collaborative browser tab is attached. Call preview_preflight with open=true or preview_open before navigating.",
                },
              );
            }

            if (!tabId) {
              const opened = await open({
                environmentId,
                input: { threadId: request.threadId },
              });
              if (opened._tag === "Failure") {
                return raiseAtomCommandFailure(opened);
              }
              applyPreviewServerSnapshot(threadRef, opened.value);
              tabId = opened.value.tabId;
            }

            const activeTabId = tabId;
            const activeRuntimeTabId = previewRuntimeTabId(
              threadRef,
              readThreadPreviewState(threadRef).serverEpoch,
              activeTabId,
            );
            await waitForDesktopOverlay(
              threadRef,
              request.requestId,
              activeTabId,
              activeRuntimeTabId,
              request.operation,
              hostDeadlineMs,
            );

            const attachedStatus = await readPreviewAutomationStatus(threadRef, activeTabId);
            if (!targetRequested) {
              return makeResult(
                {
                  requested: false,
                  reachability: "not-requested",
                  app: "not-requested",
                  origin: null,
                  environmentId: null,
                  status: null,
                },
                {
                  kind: "none",
                  message: "Browser automation is ready; no target was requested.",
                },
                attachedStatus,
              );
            }

            let resolvedUrl: string;
            try {
              const resolution = resolveBrowserNavigationTarget(
                environmentId,
                input.target ?? { kind: "url", url: input.url! },
              );
              const parsed = new URL(resolution.resolvedUrl);
              resolvedUrl = new URL("/.well-known/t3/environment", parsed.origin).toString();
            } catch {
              return makeResult(
                {
                  requested: true,
                  reachability: "unreachable",
                  app: "unknown",
                  origin: null,
                  environmentId: null,
                  status: null,
                },
                {
                  kind: "retry-target",
                  message: "The target URL could not be resolved for a token-free preflight probe.",
                },
                attachedStatus,
              );
            }

            try {
              assertPreviewRuntimeCurrent(threadRef, activeTabId, activeRuntimeTabId, request);
              await previewBridge.navigate(activeRuntimeTabId, resolvedUrl);
              await waitForNavigationReadiness(
                threadRef,
                request.requestId,
                activeTabId,
                activeRuntimeTabId,
                request.operation,
                "load",
                input.timeoutMs ?? request.timeoutMs,
              );
            } catch {
              return makeResult(
                {
                  requested: true,
                  reachability: "not-checked",
                  app: "unknown",
                  origin: new URL(resolvedUrl).origin,
                  environmentId: null,
                  status: null,
                },
                {
                  kind: "retry-browser",
                  message:
                    "The collaborative browser could not complete the preflight navigation. Retry the preflight after the browser host settles.",
                },
                attachedStatus,
              );
            }

            try {
              const probe = await previewBridge.automation.evaluate(activeRuntimeTabId, {
                expression:
                  "(async () => { const descriptorResponse = await fetch(location.href, { cache: 'no-store' }); const appResponse = await fetch(new URL('/', location.origin), { cache: 'no-store' }); const text = await descriptorResponse.text(); let descriptor = null; try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && typeof parsed.environmentId === 'string' && typeof parsed.serverVersion === 'string') descriptor = { environmentId: parsed.environmentId, serverVersion: parsed.serverVersion }; } catch {} return { origin: location.origin, descriptorStatus: descriptorResponse.status, appStatus: appResponse.status, descriptor }; })()",
                awaitPromise: true,
                returnByValue: true,
              });
              const probeResult =
                typeof probe === "object" && probe !== null
                  ? (probe as {
                      readonly origin?: unknown;
                      readonly descriptorStatus?: unknown;
                      readonly appStatus?: unknown;
                      readonly descriptor?: {
                        readonly environmentId?: unknown;
                        readonly serverVersion?: unknown;
                      } | null;
                    })
                  : {};
              const finalOrigin =
                typeof probeResult.origin === "string" ? probeResult.origin : null;
              const descriptorStatus =
                typeof probeResult.descriptorStatus === "number" &&
                Number.isInteger(probeResult.descriptorStatus)
                  ? probeResult.descriptorStatus
                  : null;
              const appStatus =
                typeof probeResult.appStatus === "number" && Number.isInteger(probeResult.appStatus)
                  ? probeResult.appStatus
                  : null;
              const descriptor = probeResult.descriptor;
              const probedEnvironmentId =
                descriptor &&
                typeof descriptor.environmentId === "string" &&
                descriptor.environmentId.trim().length > 0
                  ? EnvironmentId.make(descriptor.environmentId)
                  : null;
              const classified = classifyPreviewPreflightProbe({
                requestedOrigin: new URL(resolvedUrl).origin,
                finalOrigin,
                descriptorStatus,
                appStatus,
                environmentId: probedEnvironmentId,
                expectedEnvironmentId: input.expectedEnvironmentId ?? null,
              });
              return makeResult(classified.target, classified.recovery, attachedStatus);
            } catch {
              return makeResult(
                {
                  requested: true,
                  reachability: "unreachable",
                  app: "unknown",
                  origin: new URL(resolvedUrl).origin,
                  environmentId: null,
                  status: null,
                },
                {
                  kind: "retry-target",
                  message: "The target could not be reached by the collaborative browser.",
                },
                attachedStatus,
              );
            }
          }
          case "status": {
            if (tabId) {
              const current = readThreadPreviewState(threadRef);
              await waitForManagedTab(
                tabId,
                previewRuntimeTabId(threadRef, current.serverEpoch, tabId),
              );
            }
            return await readPreviewAutomationStatus(threadRef, tabId);
          }
          case "open": {
            const input = request.input as PreviewAutomationOpenInput;
            const resolvedInputUrl = input.url
              ? resolveBrowserNavigationTarget(environmentId, {
                  kind: "url",
                  url: input.url,
                }).resolvedUrl
              : undefined;
            let activeTabId = resolvePreviewAutomationOpenTab(
              state,
              request.tabId,
              input.reuseExistingTab ?? true,
            );
            let activeSnapshot = activeTabId
              ? (state.sessions[activeTabId] ?? state.snapshot ?? undefined)
              : undefined;
            const reusedExistingTab = activeTabId !== null;
            let managedTarget: ManagedPreviewTarget | null = null;
            tabId = activeTabId;
            if (!activeTabId) {
              const result = await openPreviewSession({
                openPreview: open,
                threadRef,
                ...(resolvedInputUrl === undefined ? {} : { url: resolvedInputUrl }),
                beforeOpen: async (profileId) => {
                  if (resolvedInputUrl === undefined) return;
                  managedTarget = await prepareManagedPreviewTarget({
                    request,
                    threadRef,
                    targetUrl: resolvedInputUrl,
                    profileId,
                  });
                },
              });
              if (result._tag === "Failure") {
                return raiseAtomCommandFailure(result);
              }
              const snapshot = result.value;
              applyPreviewServerSnapshot(threadRef, snapshot);
              activeTabId = snapshot.tabId;
              activeSnapshot = snapshot;
              tabId = activeTabId;
            } else if (resolvedInputUrl !== undefined) {
              managedTarget = await prepareManagedPreviewTarget({
                request,
                threadRef,
                targetUrl: resolvedInputUrl,
                ...(activeSnapshot?.profileId === undefined
                  ? {}
                  : { profileId: activeSnapshot.profileId }),
              });
            }
            const activeRuntimeTabId = previewRuntimeTabId(
              threadRef,
              readThreadPreviewState(threadRef).serverEpoch,
              activeTabId,
            );
            if (activeSnapshot) {
              const defaultViewport = previewAutomationDefaultViewport(
                reusedExistingTab,
                activeSnapshot,
              );
              if (defaultViewport) {
                const resizeResult = await resize({
                  environmentId,
                  input: {
                    threadId: request.threadId,
                    tabId: activeTabId,
                    viewport: defaultViewport,
                  },
                });
                if (resizeResult._tag === "Failure") {
                  return raiseAtomCommandFailure(resizeResult);
                }
                activeSnapshot = resizeResult.value;
                updatePreviewServerSnapshot(threadRef, resizeResult.value);
              }
            }
            const shouldPresent = await applyPresentationIntent(
              input,
              activeTabId,
              activeRuntimeTabId,
            );
            if (activeSnapshot && previewAutomationOpenNeedsOverlay(input, activeSnapshot)) {
              await waitForDesktopOverlay(
                threadRef,
                request.requestId,
                activeTabId,
                activeRuntimeTabId,
                request.operation,
                hostDeadlineMs,
              );
            }
            if (shouldPresent) {
              // React commits the thread-bound surface asynchronously. Settle
              // briefly so active-thread opens report visible=true.
              await waitForPreviewPresentation(activeRuntimeTabId);
            }
            if (reusedExistingTab && resolvedInputUrl && previewBridge) {
              assertPreviewRuntimeCurrent(threadRef, activeTabId, activeRuntimeTabId, request);
              await previewBridge.navigate(activeRuntimeTabId, resolvedInputUrl);
              if (managedTarget) managedTargets().set(activeTabId, managedTarget);
              else managedTargets().delete(activeTabId);
              await waitForNavigationReadiness(
                threadRef,
                request.requestId,
                activeTabId,
                activeRuntimeTabId,
                request.operation,
                "load",
                request.timeoutMs,
              );
              if (managedTarget) {
                await waitForManagedPreviewReadiness({
                  threadRef,
                  request,
                  tabId: activeTabId,
                  runtimeTabId: activeRuntimeTabId,
                  target: managedTarget,
                  targetUrl: resolvedInputUrl,
                  timeoutMs: request.timeoutMs,
                  recoverPairingPage: true,
                });
              }
            } else if (reusedExistingTab && resolvedInputUrl && request.managedTargetAuth) {
              throw new PreviewAutomationTargetUnavailableError({
                requestId: request.requestId,
                operation: request.operation,
                environmentId,
                threadId: request.threadId,
                tabId: activeTabId,
                bridgeAvailable: false,
              });
            } else if (managedTarget && resolvedInputUrl !== undefined) {
              managedTargets().set(activeTabId, managedTarget);
              await waitForManagedPreviewReadiness({
                threadRef,
                request,
                tabId: activeTabId,
                runtimeTabId: activeRuntimeTabId,
                target: managedTarget,
                targetUrl: resolvedInputUrl,
                timeoutMs: request.timeoutMs,
                recoverPairingPage: true,
              });
            } else if (resolvedInputUrl === undefined) {
              await waitForManagedTab(activeTabId, activeRuntimeTabId);
            }
            return await readPreviewAutomationStatus(threadRef, activeTabId);
          }
          case "navigate": {
            const ready = await requireReadyTab(false);
            const input = request.input as PreviewAutomationNavigateInput;
            const resolution = resolveBrowserNavigationTarget(
              environmentId,
              input.target ?? {
                kind: "url",
                url: input.url!,
              },
            );
            const activeSnapshot = readThreadPreviewState(threadRef).sessions[ready.tabId];
            const managedTarget = await prepareManagedPreviewTarget({
              request,
              threadRef,
              targetUrl: resolution.resolvedUrl,
              ...(activeSnapshot?.profileId === undefined
                ? {}
                : { profileId: activeSnapshot.profileId }),
            });
            await ready.bridge.navigate(ready.runtimeTabId, resolution.resolvedUrl);
            if (managedTarget) managedTargets().set(ready.tabId, managedTarget);
            await waitForNavigationReadiness(
              threadRef,
              request.requestId,
              ready.tabId,
              ready.runtimeTabId,
              request.operation,
              input.readiness ?? "load",
              input.timeoutMs ?? request.timeoutMs,
            );
            if (managedTarget) {
              await waitForManagedPreviewReadiness({
                threadRef,
                request,
                tabId: ready.tabId,
                runtimeTabId: ready.runtimeTabId,
                target: managedTarget,
                targetUrl: resolution.resolvedUrl,
                timeoutMs: input.timeoutMs ?? request.timeoutMs,
                recoverPairingPage: true,
              });
            } else {
              managedTargets().delete(ready.tabId);
            }
            return await readPreviewAutomationStatus(threadRef, ready.tabId);
          }
          case "resize": {
            const ready = await requireReadyTab();
            const input = request.input as PreviewAutomationResizeInput;
            const setting = resolvePreviewViewport(input);
            const operationState = assertPreviewRuntimeCurrent(
              threadRef,
              ready.tabId,
              ready.runtimeTabId,
              request,
            );
            const previousSetting =
              operationState.sessions[ready.tabId]?.viewport ?? FILL_PREVIEW_VIEWPORT;
            const result = await resize({
              environmentId,
              input: {
                threadId: request.threadId,
                tabId: ready.tabId,
                viewport: setting,
              },
            });
            if (result._tag === "Failure") {
              return raiseAtomCommandFailure(result);
            }
            updatePreviewServerSnapshot(threadRef, result.value);
            const mutation = beginPreviewViewportMutation(ready.runtimeTabId);
            let viewport: PreviewRenderedViewportSize;
            try {
              viewport = await waitForRenderedViewport(
                ready.runtimeTabId,
                setting,
                input.timeoutMs ?? request.timeoutMs,
                {
                  requestId: request.requestId,
                  environmentId,
                  threadId: request.threadId,
                },
              );
            } catch (cause) {
              // The guest never applied the requested viewport. Restore the
              // previous setting, but only while this request still owns it.
              const latestState = readThreadPreviewState(threadRef);
              const latestSetting =
                latestState.sessions[ready.tabId]?.viewport ?? FILL_PREVIEW_VIEWPORT;
              if (
                shouldRollbackPreviewViewport(
                  ready.runtimeTabId,
                  mutation,
                  previousSetting,
                  setting,
                  latestSetting,
                  operationState.serverEpoch,
                  latestState.serverEpoch,
                )
              ) {
                const rollback = await resize({
                  environmentId,
                  input: {
                    threadId: request.threadId,
                    tabId: ready.tabId,
                    viewport: previousSetting,
                  },
                });
                if (rollback._tag !== "Failure") {
                  updatePreviewServerSnapshot(threadRef, rollback.value);
                }
              }
              throw cause;
            } finally {
              finishPreviewViewportMutation(ready.runtimeTabId, mutation);
            }
            return {
              tabId: ready.tabId,
              setting,
              viewport,
            } satisfies PreviewAutomationResizeResult;
          }
          case "setColorScheme": {
            const ready = await requireReadyTab();
            const input = request.input as PreviewAutomationSetColorSchemeInput;
            await ready.bridge.setColorScheme(ready.runtimeTabId, input.colorScheme);
            return {
              tabId: ready.tabId,
              colorScheme: input.colorScheme,
            } satisfies PreviewAutomationSetColorSchemeResult;
          }
          case "listTabs": {
            const stateNow = readThreadPreviewState(threadRef);
            const surfaces = useBrowserSurfaceStore.getState().byTabId;
            const tabs = Object.values(stateNow.sessions).map((session) => {
              const runtimeTabId = previewRuntimeTabId(
                threadRef,
                stateNow.serverEpoch,
                session.tabId,
              );
              const presentation = surfaces[runtimeTabId];
              const nav = session.navStatus;
              return {
                tabId: session.tabId,
                url: nav._tag === "Idle" ? null : nav.url,
                title: nav._tag === "Idle" ? null : nav.title,
                active: stateNow.activeTabId === session.tabId,
                loading: nav._tag === "Loading",
                visible: presentation?.visible ?? false,
              };
            });
            return {
              tabs,
              activeTabId: stateNow.activeTabId,
            } satisfies PreviewAutomationTabsResult;
          }
          case "snapshot": {
            const ready = await requireReadyTab();
            const input = (request.input ?? {}) as PreviewAutomationSnapshotInput;
            const snapshot = await ready.bridge.automation.snapshot(
              ready.runtimeTabId,
              resolveSnapshotBudgets(input),
            );
            return {
              ...snapshot,
              tabId: ready.tabId,
            } satisfies PreviewAutomationSnapshot;
          }
          case "openAndSnapshot": {
            const input = request.input as PreviewAutomationOpenAndSnapshotInput;
            const openInput: PreviewAutomationOpenInput = {
              ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
              ...(input.url === undefined ? {} : { url: input.url }),
              ...(input.open === undefined ? {} : { open: input.open }),
              ...(input.show === undefined ? {} : { show: input.show }),
              ...(input.reuseExistingTab === undefined
                ? {}
                : { reuseExistingTab: input.reuseExistingTab }),
            };
            const resolvedInputUrl = openInput.url
              ? resolveBrowserNavigationTarget(environmentId, {
                  kind: "url",
                  url: openInput.url,
                }).resolvedUrl
              : input.target
                ? resolveBrowserNavigationTarget(environmentId, input.target).resolvedUrl
                : undefined;
            let activeTabId = resolvePreviewAutomationOpenTab(
              state,
              request.tabId,
              openInput.reuseExistingTab ?? true,
            );
            let activeSnapshot = activeTabId
              ? (state.sessions[activeTabId] ?? state.snapshot ?? undefined)
              : undefined;
            const reusedExistingTab = activeTabId !== null;
            let managedTarget: ManagedPreviewTarget | null = null;
            tabId = activeTabId;
            if (!activeTabId) {
              const result = await openPreviewSession({
                openPreview: open,
                threadRef,
                ...(resolvedInputUrl === undefined ? {} : { url: resolvedInputUrl }),
                beforeOpen: async (profileId) => {
                  if (resolvedInputUrl === undefined) return;
                  managedTarget = await prepareManagedPreviewTarget({
                    request,
                    threadRef,
                    targetUrl: resolvedInputUrl,
                    profileId,
                  });
                },
              });
              if (result._tag === "Failure") {
                return raiseAtomCommandFailure(result);
              }
              const snapshot = result.value;
              applyPreviewServerSnapshot(threadRef, snapshot);
              activeTabId = snapshot.tabId;
              activeSnapshot = snapshot;
              tabId = activeTabId;
            } else if (resolvedInputUrl !== undefined) {
              managedTarget = await prepareManagedPreviewTarget({
                request,
                threadRef,
                targetUrl: resolvedInputUrl,
                ...(activeSnapshot?.profileId === undefined
                  ? {}
                  : { profileId: activeSnapshot.profileId }),
              });
            }
            const activeRuntimeTabId = previewRuntimeTabId(
              threadRef,
              readThreadPreviewState(threadRef).serverEpoch,
              activeTabId,
            );
            if (activeSnapshot) {
              const defaultViewport = previewAutomationDefaultViewport(
                reusedExistingTab,
                activeSnapshot,
              );
              if (defaultViewport) {
                const resizeResult = await resize({
                  environmentId,
                  input: {
                    threadId: request.threadId,
                    tabId: activeTabId,
                    viewport: defaultViewport,
                  },
                });
                if (resizeResult._tag === "Failure") {
                  return raiseAtomCommandFailure(resizeResult);
                }
                activeSnapshot = resizeResult.value;
                updatePreviewServerSnapshot(threadRef, resizeResult.value);
              }
            }
            const shouldPresent = await applyPresentationIntent(
              openInput,
              activeTabId,
              activeRuntimeTabId,
            );
            if (activeSnapshot && previewAutomationOpenNeedsOverlay(openInput, activeSnapshot)) {
              await waitForDesktopOverlay(
                threadRef,
                request.requestId,
                activeTabId,
                activeRuntimeTabId,
                request.operation,
                hostDeadlineMs,
              );
            }
            if (shouldPresent) {
              await waitForPreviewPresentation(activeRuntimeTabId);
            }
            // New tabs already receive resolvedInputUrl via open(). Only navigate
            // when reusing an existing tab to avoid duplicate loads/side effects.
            if (reusedExistingTab && resolvedInputUrl && previewBridge) {
              assertPreviewRuntimeCurrent(threadRef, activeTabId, activeRuntimeTabId, request);
              await previewBridge.navigate(activeRuntimeTabId, resolvedInputUrl);
              if (managedTarget) managedTargets().set(activeTabId, managedTarget);
              else managedTargets().delete(activeTabId);
            } else if (reusedExistingTab && resolvedInputUrl && request.managedTargetAuth) {
              throw new PreviewAutomationTargetUnavailableError({
                requestId: request.requestId,
                operation: request.operation,
                environmentId,
                threadId: request.threadId,
                tabId: activeTabId,
                bridgeAvailable: false,
              });
            } else if (managedTarget && resolvedInputUrl !== undefined) {
              managedTargets().set(activeTabId, managedTarget);
            } else if (resolvedInputUrl !== undefined) {
              managedTargets().delete(activeTabId);
            }
            const readiness = input.readiness ?? (resolvedInputUrl !== undefined ? "load" : "none");
            if (readiness !== "none" && previewBridge) {
              await waitForNavigationReadiness(
                threadRef,
                request.requestId,
                activeTabId,
                activeRuntimeTabId,
                request.operation,
                readiness,
                input.timeoutMs ?? request.timeoutMs,
              );
            }
            const bridge = previewBridge;
            if (!bridge) {
              throw new PreviewAutomationTargetUnavailableError({
                requestId: request.requestId,
                operation: request.operation,
                environmentId,
                threadId: request.threadId,
                tabId: activeTabId,
                bridgeAvailable: false,
              });
            }
            await waitForDesktopOverlay(
              threadRef,
              request.requestId,
              activeTabId,
              activeRuntimeTabId,
              request.operation,
              hostDeadlineMs,
            );
            if (managedTarget) {
              await waitForManagedPreviewReadiness({
                threadRef,
                request,
                tabId: activeTabId,
                runtimeTabId: activeRuntimeTabId,
                target: managedTarget,
                ...(resolvedInputUrl === undefined ? {} : { targetUrl: resolvedInputUrl }),
                timeoutMs: input.timeoutMs ?? request.timeoutMs,
                recoverPairingPage: true,
              });
            } else if (resolvedInputUrl === undefined) {
              await waitForManagedTab(activeTabId, activeRuntimeTabId);
            }
            const snapshotInput = resolveSnapshotBudgets({
              includeConsole: input.includeConsole,
              includeNetwork: input.includeNetwork,
              includeAccessibilityTree: input.includeAccessibilityTree,
              consoleMode: input.consoleMode,
              networkMode: input.networkMode,
              maxVisibleText: input.maxVisibleText,
              maxInteractiveElements: input.maxInteractiveElements,
              maxScreenshotEdge: input.maxScreenshotEdge,
              maxConsoleEntries: input.maxConsoleEntries,
              maxNetworkEntries: input.maxNetworkEntries,
            });
            const snapshot = await bridge.automation.snapshot(activeRuntimeTabId, snapshotInput);
            return {
              ...snapshot,
              tabId: activeTabId,
            } satisfies PreviewAutomationOpenAndSnapshotResult;
          }
          case "click": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.click(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.click>[1],
            );
          }
          case "type": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.type(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.type>[1],
            );
          }
          case "press": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.press(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.press>[1],
            );
          }
          case "scroll": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.scroll(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.scroll>[1],
            );
          }
          case "evaluate": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.evaluate(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.evaluate>[1],
            );
          }
          case "waitFor": {
            const ready = await requireReadyTab();
            return await ready.bridge.automation.waitFor(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.waitFor>[1],
            );
          }
          case "recordingStart": {
            const ready = await requireReadyTab();
            const startedAt = await startBrowserRecording(
              ready.runtimeTabId,
              threadRef,
              ready.tabId,
            );
            return {
              tabId: ready.tabId,
              recording: true,
              startedAt,
            };
          }
          case "recordingStop": {
            const activeTargets: ReadonlyArray<BrowserRecordingStopTarget> =
              readActiveBrowserRecordingTargets(threadRef);
            const requestedRuntimeTabId =
              request.tabIdExplicit && request.tabId
                ? previewRuntimeTabId(
                    threadRef,
                    readThreadPreviewState(threadRef).serverEpoch,
                    request.tabId,
                  )
                : undefined;
            const stopTarget = resolveBrowserRecordingStopTarget(
              activeTargets,
              tabId,
              requestedRuntimeTabId,
            );
            tabId = stopTarget?.serverTabId ?? tabId;
            const artifact = stopTarget
              ? await stopBrowserRecording(stopTarget.runtimeTabId)
              : null;
            if (!artifact || !stopTarget) {
              return raisePreviewAutomationHostError(
                new PreviewAutomationRecordingNotActiveError({
                  requestId: request.requestId,
                  environmentId,
                  threadId: request.threadId,
                  tabId,
                }),
              );
            }
            return rewriteBrowserRecordingArtifactTabId(artifact, stopTarget);
          }
          case "recordingTransfer": {
            const { recordingId } = request.input as { readonly recordingId?: unknown };
            const transfer =
              typeof recordingId === "string"
                ? readSavedBrowserRecordingTransfer(recordingId)
                : null;
            if (!transfer) {
              throw PreviewAutomationOperationError.fromCause({
                requestId: request.requestId,
                operation: request.operation,
                environmentId,
                threadId: request.threadId,
                tabId,
                cause: new Error(
                  `No retained recording bytes for recording ${typeof recordingId === "string" ? recordingId : "(unknown)"}. The renderer may have reloaded since the recording stopped; stop the recording again to retry.`,
                ),
              });
            }
            return transfer;
          }
        }
      } catch (cause) {
        throw PreviewAutomationOperationError.fromCause({
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: request.threadId,
          tabId,
          cause,
        });
      } finally {
        browserActivity.release?.();
      }
    },
    [environmentId, listPreviews, open, registry, resize],
  );
  const [requestHandlerAtom] = useState(() => Atom.make({ handle: handleRequest }));
  const setRequestHandler = useAtomSet(requestHandlerAtom);
  useEffect(() => {
    setRequestHandler({ handle: handleRequest });
  }, [handleRequest, setRequestHandler]);

  const automationRequestConsumerAtom = useMemo(
    () =>
      createPreviewAutomationRequestConsumerAtom({
        requestsAtom: automationRequestsAtom,
        clientId: automationClientId,
        connectionAtom: automationConnectionAtom,
        environmentId,
        requestHandlerAtom,
        respond: (response) =>
          respondToAutomation({
            environmentId,
            input: response,
          }),
        label: `preview:automation-host:${environmentId}:${automationClientId}`,
      }),
    [
      automationClientId,
      automationConnectionAtom,
      automationRequestsAtom,
      requestHandlerAtom,
      respondToAutomation,
      environmentId,
    ],
  );
  useAtomValue(automationRequestConsumerAtom);

  useEffect(() => {
    const report = () => {
      if (!automationConnectionId) return;
      void focusAutomationHost({
        environmentId,
        input: {
          clientId: automationClientId,
          environmentId,
          connectionId: automationConnectionId,
          focused: document.hasFocus(),
        },
      });
    };
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
    };
  }, [automationClientId, automationConnectionId, environmentId, focusAutomationHost]);

  return null;
}
