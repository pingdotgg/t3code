"use client";

import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationRequest,
  PreviewAutomationOwner as PreviewAutomationOwnerState,
  PreviewAutomationStatus,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  subscribeThreadPreviewState,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { resolveBrowserNavigationTarget } from "~/browser/browserTargetResolver";
import { startBrowserRecording, stopBrowserRecording } from "~/browser/browserRecording";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentConnectionState } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";
import {
  createLatestPreviewAutomationRequestHandler,
  createPreviewAutomationRequestConsumerAtom,
} from "./previewAutomationRequestConsumer";

export function observeAutomationOwnerConnectedGeneration(
  previousGeneration: number | null,
  connectedGeneration: number | null,
): {
  readonly nextGeneration: number | null;
  readonly shouldReport: boolean;
} {
  if (connectedGeneration === null) {
    return {
      nextGeneration: previousGeneration,
      shouldReport: false,
    };
  }
  return {
    nextGeneration: connectedGeneration,
    shouldReport: previousGeneration !== connectedGeneration,
  };
}

const waitForDesktopOverlay = async (
  threadRef: ScopedThreadRef,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = readThreadPreviewState(threadRef);
    const tabId = state.snapshot?.tabId;
    if (tabId && state.desktopOverlay && previewBridge) {
      const status = await previewBridge.automation.status(tabId);
      if (status.available) return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  const error = new Error(`Preview webview did not register within ${timeoutMs}ms.`);
  error.name = "PreviewAutomationTimeoutError";
  throw error;
};

const waitForNavigationReadiness = async (
  tabId: string,
  readiness: PreviewAutomationNavigateInput["readiness"],
  timeoutMs: number,
): Promise<void> => {
  if (!previewBridge || readiness === "none") return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (readiness === "domContentLoaded") {
      const readyState = await previewBridge.automation.evaluate(tabId, {
        expression: "document.readyState",
      });
      if (readyState === "interactive" || readyState === "complete") return;
    } else {
      const status = await previewBridge.automation.status(tabId);
      if (!status.loading) return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  const error = new Error(`Preview navigation did not become ready within ${timeoutMs}ms.`);
  error.name = "PreviewAutomationTimeoutError";
  throw error;
};

const currentStatus = async (
  threadRef: ScopedThreadRef,
  visible: boolean,
): Promise<PreviewAutomationStatus> => {
  const state = readThreadPreviewState(threadRef);
  const tabId = state.snapshot?.tabId ?? null;
  if (tabId && previewBridge && state.desktopOverlay) {
    const status = await previewBridge.automation.status(tabId);
    return { ...status, visible };
  }
  const navStatus = state.snapshot?.navStatus;
  return {
    available: Boolean(previewBridge?.automation),
    visible,
    tabId,
    url: navStatus && navStatus._tag !== "Idle" ? navStatus.url : null,
    title: navStatus && navStatus._tag !== "Idle" ? navStatus.title : null,
    loading: navStatus?._tag === "Loading",
  };
};

const previewTabNotFoundError = (): Error => {
  const error = new Error("Preview tab is not initialized.");
  error.name = "PreviewAutomationTabNotFoundError";
  return error;
};

export function PreviewAutomationOwner(props: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
}) {
  const { threadRef, visible } = props;
  const automationClientId = useId();
  const initialAutomationOwner = useMemo<PreviewAutomationOwnerState>(
    () => ({
      clientId: automationClientId,
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      tabId: null,
      visible: false,
      supportsAutomation: Boolean(previewBridge?.automation),
      focusedAt: new Date().toISOString(),
    }),
    [automationClientId, threadRef.environmentId, threadRef.threadId],
  );
  const automationRequestsAtom = previewEnvironment.automationRequests({
    environmentId: threadRef.environmentId,
    input: initialAutomationOwner,
  });
  const connectionState = useEnvironmentConnectionState(threadRef.environmentId).data;
  const connectedGeneration =
    connectionState?.phase === "connected" ? connectionState.generation : null;
  const open = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const respondToAutomation = useAtomCommand(
    previewEnvironment.respondToAutomation,
    "preview automation response",
  );
  const reportAutomationOwner = useAtomCommand(
    previewEnvironment.reportAutomationOwner,
    "preview automation owner report",
  );
  const clearAutomationOwner = useAtomCommand(
    previewEnvironment.clearAutomationOwner,
    "preview automation owner clear",
  );
  const connectedGenerationRef = useRef<number | null>(null);
  const reportCurrentAutomationOwner = useEffectEvent(() => {
    const state = readThreadPreviewState(threadRef);
    return reportAutomationOwner({
      environmentId: threadRef.environmentId,
      input: {
        clientId: automationClientId,
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
        tabId: state.snapshot?.tabId ?? null,
        visible,
        supportsAutomation: Boolean(previewBridge?.automation),
        focusedAt: new Date().toISOString(),
      },
    });
  });
  useEffect(() => {
    void reportCurrentAutomationOwner();
  }, [threadRef, visible]);

  const handleRequest = useCallback(
    async (request: PreviewAutomationRequest): Promise<unknown> => {
      if (request.threadId !== threadRef.threadId) {
        const error = new Error("Preview automation request targeted a stale thread owner.");
        error.name = "PreviewAutomationUnavailableError";
        throw error;
      }
      const state = readThreadPreviewState(threadRef);
      const tabId = request.tabId ?? state.snapshot?.tabId ?? null;
      switch (request.operation) {
        case "status":
          return currentStatus(threadRef, visible);
        case "open": {
          const input = request.input as PreviewAutomationOpenInput;
          let activeTabId =
            (input.reuseExistingTab ?? true) ? (state.snapshot?.tabId ?? null) : null;
          if (!activeTabId) {
            const result = await open({
              environmentId: threadRef.environmentId,
              input: {
                threadId: threadRef.threadId,
                ...(input.url ? { url: input.url } : {}),
              },
            });
            if (result._tag === "Failure") {
              throw squashAtomCommandFailure(result);
            }
            const snapshot = result.value;
            applyPreviewServerSnapshot(threadRef, snapshot);
            activeTabId = snapshot.tabId;
          } else if (input.url && previewBridge) {
            await previewBridge.navigate(activeTabId, input.url);
          }
          if (input.show ?? true) {
            useRightPanelStore.getState().openBrowser(threadRef, activeTabId);
          }
          await waitForDesktopOverlay(threadRef, request.timeoutMs);
          return currentStatus(threadRef, input.show ?? true);
        }
        case "navigate": {
          if (!previewBridge || !tabId) throw previewTabNotFoundError();
          const input = request.input as PreviewAutomationNavigateInput;
          const resolution = resolveBrowserNavigationTarget(
            threadRef.environmentId,
            input.target ?? { kind: "url", url: input.url! },
          );
          await previewBridge.navigate(tabId, resolution.resolvedUrl);
          await waitForNavigationReadiness(
            tabId,
            input.readiness ?? "load",
            input.timeoutMs ?? request.timeoutMs,
          );
          return currentStatus(threadRef, visible);
        }
        case "snapshot":
          if (!previewBridge || !tabId) throw previewTabNotFoundError();
          return previewBridge.automation.snapshot(tabId);
        case "click":
          if (!previewBridge || !tabId) throw previewTabNotFoundError();
          return previewBridge.automation.click(
            tabId,
            request.input as Parameters<typeof previewBridge.automation.click>[1],
          );
        case "type":
          if (!previewBridge || !tabId) throw previewTabNotFoundError();
          return previewBridge.automation.type(
            tabId,
            request.input as Parameters<typeof previewBridge.automation.type>[1],
          );
        case "press":
          if (!previewBridge || !tabId) throw previewTabNotFoundError();
          return previewBridge.automation.press(
            tabId,
            request.input as Parameters<typeof previewBridge.automation.press>[1],
          );
        case "scroll":
          if (!previewBridge || !tabId) throw previewTabNotFoundError();
          return previewBridge.automation.scroll(
            tabId,
            request.input as Parameters<typeof previewBridge.automation.scroll>[1],
          );
        case "evaluate":
          if (!previewBridge || !tabId) throw previewTabNotFoundError();
          return previewBridge.automation.evaluate(
            tabId,
            request.input as Parameters<typeof previewBridge.automation.evaluate>[1],
          );
        case "waitFor":
          if (!previewBridge || !tabId) throw previewTabNotFoundError();
          return previewBridge.automation.waitFor(
            tabId,
            request.input as Parameters<typeof previewBridge.automation.waitFor>[1],
          );
        case "recordingStart": {
          if (!tabId) throw previewTabNotFoundError();
          const startedAt = await startBrowserRecording(tabId);
          return {
            tabId,
            recording: true,
            startedAt,
          };
        }
        case "recordingStop": {
          if (!tabId) throw previewTabNotFoundError();
          const artifact = await stopBrowserRecording(tabId);
          if (!artifact) throw new Error("No active recording exists for this preview tab.");
          return artifact;
        }
      }
    },
    [open, threadRef, visible],
  );
  const [requestHandler] = useState(() =>
    createLatestPreviewAutomationRequestHandler(handleRequest),
  );
  useEffect(() => {
    requestHandler.set(handleRequest);
  }, [handleRequest, requestHandler]);

  const automationRequestConsumerAtom = useMemo(
    () =>
      createPreviewAutomationRequestConsumerAtom({
        requestsAtom: automationRequestsAtom,
        handleRequest: requestHandler.handle,
        respond: (response) =>
          respondToAutomation({
            environmentId: threadRef.environmentId,
            input: response,
          }),
        label: `preview:automation-request-consumer:${automationClientId}`,
      }),
    [
      automationClientId,
      automationRequestsAtom,
      requestHandler,
      respondToAutomation,
      threadRef.environmentId,
    ],
  );
  useAtomValue(automationRequestConsumerAtom);

  useEffect(() => {
    const observation = observeAutomationOwnerConnectedGeneration(
      connectedGenerationRef.current,
      connectedGeneration,
    );
    connectedGenerationRef.current = observation.nextGeneration;
    if (!observation.shouldReport) return;

    void reportCurrentAutomationOwner();
  }, [connectedGeneration]);

  useEffect(() => {
    const report = () => void reportCurrentAutomationOwner();
    window.addEventListener("focus", report);
    const unsubscribe = subscribeThreadPreviewState(threadRef, (state, previous) => {
      if (state.snapshot?.tabId !== previous.snapshot?.tabId) {
        report();
      }
    });
    return () => {
      window.removeEventListener("focus", report);
      unsubscribe();
      void clearAutomationOwner({
        environmentId: threadRef.environmentId,
        input: {
          clientId: automationClientId,
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
        },
      });
    };
  }, [automationClientId, clearAutomationOwner, threadRef]);

  return null;
}
