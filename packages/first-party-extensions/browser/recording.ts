import {
  resolveBrowserRecording,
  uiNotificationsApi,
  type BrowserCaptureHost,
  type BrowserRecordingPhase,
} from "@t3tools/extension-sdk/catalogue";
import { bindApi, grantDenialMessage } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import { useEffect, useRef, useState } from "react";
import {
  CAPTURE_TOAST_DURATION_MS,
  NOTIFY_ACK_TIMEOUT_MS,
  serveCaptureToastActions,
  type CapturePageView,
  type CaptureSessionRef,
  type CaptureToast,
  type CaptureToastAction,
} from "./capture.ts";

export function recordingUnavailableReason(
  host: Pick<ClientHost, "browserCapture">,
  held: CaptureSessionRef | null,
  page: CapturePageView,
): string | null {
  const capture = resolveBrowserRecording(host.browserCapture);
  if (!capture) return "This host cannot record browser sessions.";
  if (!capture.recordingSupport.supported)
    return capture.recordingSupport.reason === "grant-denied"
      ? grantDenialMessage(capture.recordingSupport.grant)
      : "Record from the T3 Code desktop app.";
  if (!held) return "Open a page before recording.";
  if (page !== "shown") return "The page must be shown here before recording.";
  return null;
}

export function recordingToastActions(capture: BrowserCaptureHost): readonly CaptureToastAction[] {
  const support = capture.recordingArtifactActions ?? capture.artifactActions;
  if (!support) return [];
  const actions: CaptureToastAction[] = [];
  if (support.reveal.supported && capture.revealArtifact)
    actions.push({ id: "reveal", label: support.revealLabel, variant: "primary", keepOpen: true });
  if (support.copyPath.supported && capture.copyArtifactPath)
    actions.push({ id: "copy-path", label: "Copy path", keepOpen: true });
  return actions;
}

export async function runBrowserRecording(
  host: Pick<ClientHost, "browserCapture" | "invokeApi" | "discoverApis">,
  session: Pick<ViewSession, "context" | "signal">,
  held: CaptureSessionRef,
  stopping: boolean,
): Promise<string | null> {
  const capture = resolveBrowserRecording(host.browserCapture);
  if (!capture) return "This host cannot record browser sessions.";
  let toast: CaptureToast;
  let artifactRef: string | null = null;
  try {
    const request = { context: session.context, session: held, signal: session.signal };
    const result = stopping
      ? await capture.stopRecording(request)
      : await capture.startRecording(request);
    if (session.signal.aborted) return null;
    if (!result.ok) {
      if (result.failure.reason === "cancelled") return null;
      toast = {
        severity: "error",
        title: stopping ? "Unable to stop recording" : "Unable to start recording",
        body: result.failure.grant
          ? grantDenialMessage(result.failure.grant)
          : result.failure.detail,
        durationMs: CAPTURE_TOAST_DURATION_MS,
      };
    } else {
      if (!("artifact" in result) || !result.artifact) return null;
      artifactRef = result.artifact.artifactRef;
      toast = {
        severity: "success",
        title: "Recording saved",
        durationMs: CAPTURE_TOAST_DURATION_MS,
        ...(result.artifact.saved ? { actions: recordingToastActions(capture) } : {}),
      };
    }
  } catch {
    if (session.signal.aborted) return null;
    toast = {
      severity: "error",
      title: stopping ? "Unable to stop recording" : "Unable to start recording",
      body: "The desktop recording operation failed.",
      durationMs: CAPTURE_TOAST_DURATION_MS,
    };
  }
  const signal = AbortSignal.any([session.signal, AbortSignal.timeout(NOTIFY_ACK_TIMEOUT_MS)]);
  const { actions, ...plain } = toast;
  const input = {
    ...plain,
    threadId: session.context.resource.threadId,
    anchor: "thread" as const,
  };
  let notifications = bindApi(uiNotificationsApi, host, session.context);
  try {
    let withActions = false;
    if (actions?.length) {
      try {
        const selected = (await host.discoverApis(session.context, signal)).find(
          (api) => api.id === uiNotificationsApi.definition.id && api.selected,
        );
        withActions = selected !== undefined && satisfiesSemverRange(selected.version, "^1.1.0");
      } catch {}
    }
    if (withActions) notifications = bindApi(uiNotificationsApi, host, session.context, "^1.1.0");
    const notify = (offeredActions?: readonly CaptureToastAction[]) =>
      notifications.invoke(
        "notify",
        { ...input, ...(offeredActions ? { actions: offeredActions } : {}) },
        signal,
      );
    const { notificationId } = await (withActions
      ? notify(actions).catch(() => {
          if (signal.aborted) throw new Error("Notification delivery ended.");
          withActions = false;
          return notify();
        })
      : notify());
    if (withActions && artifactRef)
      void serveCaptureToastActions(
        notifications,
        capture,
        { context: session.context, artifactRef },
        notificationId,
        session.signal,
        "recording",
      );
    return null;
  } catch {
    return signal.aborted ? null : (toast.body ?? toast.title);
  }
}

export function useBrowserRecording(
  host: ClientHost,
  session: ViewSession,
  held: CaptureSessionRef | null,
  page: CapturePageView,
  onStatus?: (line: string | null) => void,
) {
  const [state, setState] = useState<{
    readonly context: ViewSession["context"];
    readonly tabId: string;
    readonly serverEpoch: string;
    readonly phase: BrowserRecordingPhase;
  } | null>(null);
  const current = useRef<AbortController | null>(null);
  const operation = useRef<"start" | "stop" | null>(null);
  const capture = resolveBrowserRecording(host.browserCapture);
  const tabId = held?.tabId;
  const serverEpoch = held?.serverEpoch;
  const context = session.context;
  const phase =
    state?.context === context && state.tabId === tabId && state.serverEpoch === serverEpoch
      ? state.phase
      : "idle";
  useEffect(() => {
    operation.current = null;
    const controller = new AbortController();
    current.current = controller;
    if (!capture || !tabId || !serverEpoch) return () => controller.abort();
    const signal = AbortSignal.any([session.signal, controller.signal]);
    const unsubscribe = capture.subscribeRecording(
      { context, session: { tabId, serverEpoch }, signal },
      (state) => {
        if (!signal.aborted && state.ok)
          setState({ context, tabId, serverEpoch, phase: state.phase });
      },
    );
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [capture, tabId, serverEpoch, context, session.signal]);
  const blockReason = recordingUnavailableReason(host, held, page);
  const toggle = async () => {
    const stopping = phase !== "idle";
    if (!held || !capture || operation.current === "stop" || (!stopping && operation.current))
      return;
    if (!stopping && blockReason) {
      onStatus?.(blockReason);
      return;
    }
    const controller = current.current;
    if (!controller || controller.signal.aborted) return;
    const action = stopping ? "stop" : "start";
    operation.current = action;
    onStatus?.(null);
    const message = await runBrowserRecording(
      host,
      { context: session.context, signal: AbortSignal.any([session.signal, controller.signal]) },
      held,
      stopping,
    );
    if (current.current !== controller || controller.signal.aborted) return;
    if (operation.current === action) operation.current = null;
    if (message) onStatus?.(message);
  };
  return { phase, blockReason, available: capture?.recordingSupport.supported === true, toggle };
}
