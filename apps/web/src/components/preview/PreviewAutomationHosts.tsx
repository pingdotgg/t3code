"use client";

import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_AUTOMATION_OPERATIONS,
  type EnvironmentId,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationResizeInput,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationSetColorSchemeResult,
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
import { resolveBrowserNavigationTarget } from "~/browser/browserTargetResolver";
import {
  isBrowserRecordingStopDeadlineError,
  readActiveBrowserRecordingTargets,
  startBrowserRecording,
  stopBrowserRecording,
  stopBrowserRecordingForUpload,
} from "~/browser/browserRecording";
import { resolveBrowserRecordingStopTarget } from "~/browser/browserRecordingScope";
import { uploadBrowserRecording } from "~/browser/browserRecordingUpload";
import {
  acquireBrowserSurfaceActivity,
  useBrowserSurfaceStore,
} from "~/browser/browserSurfaceStore";
import { resolveBrowserDefaults } from "~/browser/browserDefaults";
import { runBrowserViewportMutation } from "~/browser/browserViewportActions";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";
import { closePreviewAutomationTab } from "./closePreviewAutomationTab";
import {
  revealPreviewAutomationTab,
  waitForBrowserSurfaceVisibility,
  waitForPreviewPresentation,
  withPreviewAutomationBackgroundPresentation,
} from "./previewAutomationPresentation";
import {
  PreviewAutomationHostDeadlineExceededError,
  PreviewAutomationOperationError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationViewportTimeoutError,
} from "./previewAutomationErrors";
import {
  explicitlySuppressesPreviewMiniPlayer,
  previewAutomationDefaultViewport,
  previewAutomationNewTabDefaults,
  resolvePreviewAutomationOpenWaitPolicy,
  shouldAutoShowPreviewForAutomationUse,
  shouldOpenPreviewMiniPlayer,
} from "./previewAutomationOpenReadiness";
import {
  isPreviewAutomationPresentationSuppressed,
  prunePreviewAutomationPresentationSuppressions,
  setPreviewAutomationPresentationSuppressed,
  type PreviewAutomationPresentationSuppressions,
} from "./previewAutomationPresentationSuppression";
import { waitForDesktopOverlay } from "./previewAutomationOverlayReadiness";
import {
  createPreviewAutomationRequestConsumerAtom,
  previewAutomationExecutionBudget,
  previewAutomationInputWithRemainingTimeout,
  previewAutomationRemainingBestEffortBudget,
  previewAutomationRemainingBudget,
} from "./previewAutomationRequestConsumer";
import {
  assertPreviewRuntimeCurrent,
  waitForNavigationReadiness,
} from "./previewNavigationReadiness";
import {
  createPreviewAutomationClientId,
  getOrCreatePreviewAutomationHostId,
  resolvePreviewAutomationHostMetadata,
} from "./previewAutomationClientId";
import {
  needsPreviewAutomationSessionSync,
  resolvePreviewAutomationOpenTab,
  resolvePreviewAutomationTarget,
} from "./previewAutomationTarget";
import { waitForPreviewViewportReadiness } from "./previewViewportReadiness";
import { shouldRollbackPreviewViewport } from "./previewViewportRollback";

interface ExecutablePreviewWebview extends Element {
  readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

const findPreviewWebview = (tabId: string): ExecutablePreviewWebview | null =>
  Array.from(document.querySelectorAll<ExecutablePreviewWebview>("webview[data-preview-tab]")).find(
    (candidate) => candidate.getAttribute("data-preview-tab") === tabId,
  ) ?? null;

const isPreviewWebviewRendering = (runtimeTabId: string): boolean => {
  const wrapper = findPreviewWebview(runtimeTabId)?.closest<HTMLElement>("[data-preview-viewport]");
  return wrapper?.getAttribute("data-preview-rendering") === "active";
};

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

const readRenderedViewport = async (
  runtimeTabId: string,
): Promise<PreviewRenderedViewportSize | null> => {
  const webview = findPreviewWebview(runtimeTabId);
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
  threadRef: ScopedThreadRef,
  tabId: string,
  runtimeTabId: string,
  setting: PreviewViewportSetting,
  timeoutMs: number,
  context: {
    readonly requestId: PreviewAutomationRequest["requestId"];
    readonly operation: PreviewAutomationRequest["operation"];
    readonly environmentId: EnvironmentId;
    readonly threadId: PreviewAutomationRequest["threadId"];
  },
): Promise<PreviewRenderedViewportSize> => {
  const renderedViewport = await waitForPreviewViewportReadiness({
    setting,
    timeoutMs,
    assertCurrent: () => assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, context),
    readViewport: async () => {
      const webview = findPreviewWebview(runtimeTabId);
      if (!webview) return null;
      const appliedSettingKey = webview?.getAttribute("data-preview-viewport-key") ?? null;
      const declaredViewport = readDeclaredViewport(webview);
      return {
        appliedSettingKey,
        declaredViewport,
        renderedViewport: await readWebviewViewport(webview),
      };
    },
  });
  if (renderedViewport) return renderedViewport;
  throw new PreviewAutomationViewportTimeoutError({
    ...context,
    tabId,
    timeoutMs,
  });
};

const currentStatus = async (
  threadRef: ScopedThreadRef,
  requestedTabId: string | null,
): Promise<PreviewAutomationStatus> => {
  const state = readThreadPreviewState(threadRef);
  const { snapshot, tabId } = resolvePreviewAutomationTarget(state, requestedTabId);
  const runtimeTabId = tabId ? previewRuntimeTabId(threadRef, state.serverEpoch, tabId) : null;
  const visible = runtimeTabId
    ? (useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible ?? false)
    : false;
  const renderingActive = runtimeTabId ? isPreviewWebviewRendering(runtimeTabId) : false;
  const viewportSetting = snapshot ? (snapshot.viewport ?? FILL_PREVIEW_VIEWPORT) : undefined;
  const viewport =
    runtimeTabId && renderingActive
      ? await readRenderedViewport(runtimeTabId).catch(() => null)
      : null;
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
  if (!isElectron || !previewBridge?.automation) return null;
  return (
    <>
      {/*
       * Host lifetime follows the desktop runtime's environment connections,
       * not the routed thread. This keeps background threads automatable and
       * lets the subscription runtime own reconnects for every saved target.
       */}
      {environments.map((environment) => (
        <PreviewAutomationHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </>
  );
}

function PreviewAutomationHost(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const registry = useContext(RegistryContext);
  const [automationClientId] = useState(createPreviewAutomationClientId);
  const [automationHostId] = useState(getOrCreatePreviewAutomationHostId);
  const automationHostMetadata = useMemo(
    () =>
      resolvePreviewAutomationHostMetadata(
        window.desktopBridge?.getPreviewAutomationHostMetadata?.(),
        navigator.platform,
        automationHostId,
      ),
    [automationHostId],
  );
  const initialAutomationHost = useMemo<PreviewAutomationHostState>(
    () => ({
      clientId: automationClientId,
      hostId: automationHostId,
      environmentId,
      ...automationHostMetadata,
      supportedOperations: [...PREVIEW_AUTOMATION_OPERATIONS],
    }),
    [automationClientId, automationHostId, automationHostMetadata, environmentId],
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
  const close = useAtomCommand(previewEnvironment.close, {
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
  const presentationSuppressedRuntimeTabsRef = useRef<PreviewAutomationPresentationSuppressions>(
    new Map(),
  );

  const handleRequest = useCallback(
    async (request: PreviewAutomationRequest): Promise<unknown> => {
      const operationBudgetMs = previewAutomationExecutionBudget(request.timeoutMs);
      const operationDeadline = Date.now() + operationBudgetMs;
      const remainingOperationBudget = (requestedTimeoutMs = request.timeoutMs): number => {
        const remainingMs = previewAutomationRemainingBudget(operationDeadline, requestedTimeoutMs);
        if (remainingMs > 0) return remainingMs;
        throw new PreviewAutomationHostDeadlineExceededError({
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: request.threadId,
          tabId,
          timeoutMs: operationBudgetMs,
        });
      };
      const threadRef: ScopedThreadRef = {
        environmentId,
        threadId: request.threadId,
      };
      const threadKey = scopedThreadKey(threadRef);
      let tabId = request.tabId ?? null;
      const browserActivity = { release: null as (() => void) | null };
      try {
        const openBrowserDefaults =
          request.operation === "open" ? await resolveBrowserDefaults() : undefined;
        let state = readThreadPreviewState(threadRef);
        const needsSessionSync = needsPreviewAutomationSessionSync(state, request.tabId);
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
          state = readThreadPreviewState(threadRef);
        }
        tabId = request.tabId ?? state.snapshot?.tabId ?? null;
        prunePreviewAutomationPresentationSuppressions(
          presentationSuppressedRuntimeTabsRef.current,
          threadKey,
          new Set(
            Object.keys(state.sessions).map((sessionTabId) =>
              previewRuntimeTabId(threadRef, state.serverEpoch, sessionTabId),
            ),
          ),
        );
        const unavailableTarget = {
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: request.threadId,
          tabId,
          bridgeAvailable: Boolean(previewBridge),
        };
        const requireReadyTab = async () => {
          const bridge = previewBridge;
          const readyTabId = tabId;
          if (!bridge || !readyTabId) {
            throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
          }
          const readyState = readThreadPreviewState(threadRef);
          const runtimeTabId = previewRuntimeTabId(threadRef, readyState.serverEpoch, readyTabId);
          if (request.operation !== "open") {
            const { autoShowFloatingPreview } = await resolveBrowserDefaults();
            assertPreviewRuntimeCurrent(threadRef, readyTabId, runtimeTabId, request);
            remainingOperationBudget();
            if (
              shouldAutoShowPreviewForAutomationUse({
                operation: request.operation,
                autoShowFloatingPreview,
                presentationSuppressed: isPreviewAutomationPresentationSuppressed(
                  presentationSuppressedRuntimeTabsRef.current,
                  threadKey,
                  runtimeTabId,
                ),
              })
            ) {
              usePreviewMiniPlayerStore
                .getState()
                .open(threadRef, browserMiniPlayerSource(readyTabId));
            }
          }
          browserActivity.release ??= acquireBrowserSurfaceActivity(runtimeTabId);
          await waitForDesktopOverlay(
            threadRef,
            request.requestId,
            readyTabId,
            runtimeTabId,
            request.operation,
            remainingOperationBudget(),
          );
          return {
            bridge,
            tabId: readyTabId,
            runtimeTabId,
          };
        };
        switch (request.operation) {
          case "status":
            return await currentStatus(threadRef, tabId);
          case "open": {
            const input = request.input as PreviewAutomationOpenInput;
            if (!openBrowserDefaults) {
              throw new Error("Browser defaults were not resolved for preview open");
            }
            const shouldPresentPreview = shouldOpenPreviewMiniPlayer(
              input,
              openBrowserDefaults.autoShowFloatingPreview,
            );
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
            tabId = activeTabId;
            if (!activeTabId) {
              remainingOperationBudget();
              const result = await open({
                environmentId,
                input: {
                  threadId: request.threadId,
                  ...(resolvedInputUrl ? { url: resolvedInputUrl } : {}),
                  // Profile and viewport are fixed when the guest attaches.
                  // Use the same configured defaults as a hand-opened tab.
                  ...previewAutomationNewTabDefaults(openBrowserDefaults),
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
                const resizeResult = await runBrowserViewportMutation(
                  activeRuntimeTabId,
                  async () => {
                    assertPreviewRuntimeCurrent(
                      threadRef,
                      activeTabId,
                      activeRuntimeTabId,
                      request,
                    );
                    remainingOperationBudget();
                    return await resize({
                      environmentId,
                      input: {
                        threadId: request.threadId,
                        tabId: activeTabId,
                        viewport: defaultViewport,
                      },
                    });
                  },
                );
                if (resizeResult._tag === "Failure") {
                  return raiseAtomCommandFailure(resizeResult);
                }
                activeSnapshot = resizeResult.value;
                updatePreviewServerSnapshot(threadRef, resizeResult.value);
              }
            }
            assertPreviewRuntimeCurrent(threadRef, activeTabId, activeRuntimeTabId, request);
            remainingOperationBudget();
            const explicitlySuppressed = explicitlySuppressesPreviewMiniPlayer(input);
            if (explicitlySuppressed || shouldPresentPreview) {
              setPreviewAutomationPresentationSuppressed(
                presentationSuppressedRuntimeTabsRef.current,
                threadKey,
                activeRuntimeTabId,
                explicitlySuppressed,
              );
            }
            if (explicitlySuppressed) {
              const miniPlayerTabId = selectThreadPreviewMiniPlayerTabId(
                usePreviewMiniPlayerStore.getState().byThreadKey,
                threadRef,
              );
              if (miniPlayerTabId === activeTabId) {
                usePreviewMiniPlayerStore.getState().close(threadRef);
              }
            }
            if (shouldPresentPreview) {
              revealPreviewAutomationTab(threadRef, activeTabId);
            }
            const waitPolicy = activeSnapshot
              ? resolvePreviewAutomationOpenWaitPolicy(
                  input,
                  activeSnapshot,
                  reusedExistingTab,
                  shouldPresentPreview,
                )
              : null;
            if (waitPolicy?.acknowledgeAfterCreation) {
              return await currentStatus(threadRef, activeTabId);
            }
            if (waitPolicy?.waitForOverlay) {
              await waitForDesktopOverlay(
                threadRef,
                request.requestId,
                activeTabId,
                activeRuntimeTabId,
                request.operation,
                remainingOperationBudget(),
              );
            }
            if (shouldPresentPreview) {
              // React commits the thread-bound surface asynchronously. Settle
              // briefly so active-thread opens report visible=true, without
              // turning a background thread's offscreen mini player into an
              // operation failure.
              await waitForPreviewPresentation(
                activeRuntimeTabId,
                previewAutomationRemainingBestEffortBudget(operationDeadline, request.timeoutMs),
              );
            }
            if (reusedExistingTab && resolvedInputUrl && previewBridge) {
              assertPreviewRuntimeCurrent(threadRef, activeTabId, activeRuntimeTabId, request);
              remainingOperationBudget();
              await previewBridge.navigate(activeRuntimeTabId, resolvedInputUrl);
              await waitForNavigationReadiness(
                threadRef,
                request.requestId,
                activeTabId,
                activeRuntimeTabId,
                request.operation,
                "load",
                remainingOperationBudget(),
              );
            }
            if (waitPolicy?.waitForVisibility) {
              await waitForBrowserSurfaceVisibility({
                threadRef,
                requestId: request.requestId,
                tabId: activeTabId,
                runtimeTabId: activeRuntimeTabId,
                timeoutMs: remainingOperationBudget(),
              });
            }
            return await currentStatus(threadRef, activeTabId);
          }
          case "close": {
            const closeTabId = tabId;
            if (!closeTabId) return await currentStatus(threadRef, null);
            const bridge = previewBridge;
            if (!bridge) {
              throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
            }
            const closeState = readThreadPreviewState(threadRef);
            const runtimeTabId = previewRuntimeTabId(threadRef, closeState.serverEpoch, closeTabId);
            remainingOperationBudget();
            const result = await closePreviewAutomationTab({
              closePreview: close,
              closeRuntimeTab: (targetRuntimeTabId) => bridge.closeTab(targetRuntimeTabId),
              runtimeTabId,
              snapshot: closeState.sessions[closeTabId] ?? null,
              tabId: closeTabId,
              threadRef,
            });
            if (result._tag === "Failure") {
              return raiseAtomCommandFailure(result);
            }
            setPreviewAutomationPresentationSuppressed(
              presentationSuppressedRuntimeTabsRef.current,
              threadKey,
              runtimeTabId,
              false,
            );
            return await currentStatus(threadRef, closeTabId);
          }
          case "navigate": {
            const ready = await requireReadyTab();
            const input = request.input as PreviewAutomationNavigateInput;
            const resolution = resolveBrowserNavigationTarget(
              environmentId,
              input.target ?? {
                kind: "url",
                url: input.url!,
              },
            );
            await ready.bridge.navigate(ready.runtimeTabId, resolution.resolvedUrl);
            await waitForNavigationReadiness(
              threadRef,
              request.requestId,
              ready.tabId,
              ready.runtimeTabId,
              request.operation,
              input.readiness ?? "load",
              remainingOperationBudget(input.timeoutMs ?? request.timeoutMs),
            );
            return await currentStatus(threadRef, ready.tabId);
          }
          case "resize": {
            const ready = await requireReadyTab();
            const input = request.input as PreviewAutomationResizeInput;
            const setting = resolvePreviewViewport(input);
            const applied = await runBrowserViewportMutation(ready.runtimeTabId, async () => {
              remainingOperationBudget(input.timeoutMs ?? request.timeoutMs);
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
              return {
                previousSetting,
                serverEpoch: operationState.serverEpoch,
              };
            });
            let viewport: PreviewRenderedViewportSize;
            try {
              viewport = await waitForRenderedViewport(
                threadRef,
                ready.tabId,
                ready.runtimeTabId,
                setting,
                remainingOperationBudget(input.timeoutMs ?? request.timeoutMs),
                {
                  requestId: request.requestId,
                  operation: request.operation,
                  environmentId,
                  threadId: request.threadId,
                },
              );
            } catch (cause) {
              await runBrowserViewportMutation(ready.runtimeTabId, async () => {
                const latestState = readThreadPreviewState(threadRef);
                const latestSetting =
                  latestState.sessions[ready.tabId]?.viewport ?? FILL_PREVIEW_VIEWPORT;
                if (
                  shouldRollbackPreviewViewport(
                    applied.previousSetting,
                    setting,
                    latestSetting,
                    applied.serverEpoch,
                    latestState.serverEpoch,
                  )
                ) {
                  const rollback = await resize({
                    environmentId,
                    input: {
                      threadId: request.threadId,
                      tabId: ready.tabId,
                      viewport: applied.previousSetting,
                    },
                  });
                  if (rollback._tag !== "Failure") {
                    updatePreviewServerSnapshot(threadRef, rollback.value);
                  }
                }
              });
              throw cause;
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
            await ready.bridge.setColorScheme(
              ready.runtimeTabId,
              input.colorScheme,
              remainingOperationBudget(input.timeoutMs ?? request.timeoutMs),
            );
            return {
              tabId: ready.tabId,
              colorScheme: input.colorScheme,
            } satisfies PreviewAutomationSetColorSchemeResult;
          }
          case "snapshot": {
            const ready = await requireReadyTab();
            const presentationTimeoutMs = remainingOperationBudget();
            return await withPreviewAutomationBackgroundPresentation({
              threadRef,
              requestId: request.requestId,
              tabId: ready.tabId,
              runtimeTabId: ready.runtimeTabId,
              timeoutMs: presentationTimeoutMs,
              use: async (background) =>
                await ready.bridge.automation.snapshot(
                  ready.runtimeTabId,
                  background,
                  remainingOperationBudget(),
                ),
            });
          }
          case "click": {
            const ready = await requireReadyTab();
            const input = request.input as Parameters<typeof ready.bridge.automation.click>[1];
            return await ready.bridge.automation.click(
              ready.runtimeTabId,
              previewAutomationInputWithRemainingTimeout(
                input,
                request.timeoutMs,
                remainingOperationBudget,
              ),
            );
          }
          case "type": {
            const ready = await requireReadyTab();
            const input = request.input as Parameters<typeof ready.bridge.automation.type>[1];
            return await ready.bridge.automation.type(
              ready.runtimeTabId,
              previewAutomationInputWithRemainingTimeout(
                input,
                request.timeoutMs,
                remainingOperationBudget,
              ),
            );
          }
          case "press": {
            const ready = await requireReadyTab();
            const input = request.input as Parameters<typeof ready.bridge.automation.press>[1];
            return await ready.bridge.automation.press(
              ready.runtimeTabId,
              previewAutomationInputWithRemainingTimeout(
                input,
                request.timeoutMs,
                remainingOperationBudget,
              ),
            );
          }
          case "scroll": {
            const ready = await requireReadyTab();
            const input = request.input as Parameters<typeof ready.bridge.automation.scroll>[1];
            return await ready.bridge.automation.scroll(
              ready.runtimeTabId,
              previewAutomationInputWithRemainingTimeout(
                input,
                request.timeoutMs,
                remainingOperationBudget,
              ),
            );
          }
          case "evaluate": {
            const ready = await requireReadyTab();
            const input = request.input as Parameters<typeof ready.bridge.automation.evaluate>[1];
            return await ready.bridge.automation.evaluate(
              ready.runtimeTabId,
              previewAutomationInputWithRemainingTimeout(
                input,
                request.timeoutMs,
                remainingOperationBudget,
              ),
            );
          }
          case "waitFor": {
            const ready = await requireReadyTab();
            const input = request.input as Parameters<typeof ready.bridge.automation.waitFor>[1];
            return await ready.bridge.automation.waitFor(
              ready.runtimeTabId,
              previewAutomationInputWithRemainingTimeout(
                input,
                request.timeoutMs,
                remainingOperationBudget,
              ),
            );
          }
          case "recordingStart": {
            const ready = await requireReadyTab();
            const startedAt = await startBrowserRecording(
              ready.runtimeTabId,
              threadRef,
              ready.tabId,
              remainingOperationBudget(request.timeoutMs),
            );
            return {
              tabId: ready.tabId,
              recording: true,
              startedAt,
            };
          }
          case "recordingStop": {
            const activeRecordings = readActiveBrowserRecordingTargets(threadRef);
            const activeTabIds = new Set(
              activeRecordings.map((recording) => recording.serverTabId),
            );
            const stopTabId = resolveBrowserRecordingStopTarget(
              activeTabIds,
              tabId,
              request.tabIdExplicit ? request.tabId : undefined,
            );
            tabId = stopTabId ?? tabId;
            const stopRuntimeTabId =
              activeRecordings.find((recording) => recording.serverTabId === stopTabId)
                ?.runtimeTabId ?? null;
            const transferToEnvironment =
              typeof request.input === "object" &&
              request.input !== null &&
              "transferToEnvironment" in request.input &&
              request.input.transferToEnvironment === true;
            let artifact = null;
            if (stopRuntimeTabId) {
              try {
                artifact = transferToEnvironment
                  ? await stopBrowserRecordingForUpload(
                      stopRuntimeTabId,
                      (saved, blob) =>
                        uploadBrowserRecording(threadRef, saved, blob, operationDeadline),
                      remainingOperationBudget(request.timeoutMs),
                    )
                  : await stopBrowserRecording(
                      stopRuntimeTabId,
                      remainingOperationBudget(request.timeoutMs),
                    );
              } catch (cause) {
                if (isBrowserRecordingStopDeadlineError(cause)) {
                  remainingOperationBudget(request.timeoutMs);
                }
                throw cause;
              }
            }
            if (!artifact || !stopTabId) {
              return raisePreviewAutomationHostError(
                new PreviewAutomationRecordingNotActiveError({
                  requestId: request.requestId,
                  environmentId,
                  threadId: request.threadId,
                  tabId,
                }),
              );
            }
            return {
              ...artifact,
              tabId: stopTabId,
            };
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
    [close, environmentId, listPreviews, open, registry, resize],
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
