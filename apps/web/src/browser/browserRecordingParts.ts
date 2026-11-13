import {
  DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER,
  PreviewCaptureFailure,
} from "@t3tools/contracts";
import type { DesktopPreviewRecordingArtifact, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";
import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { createRecordingCompositor } from "./recordingCompositor";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";
import { BrowserRecordingConflictError, BrowserRecordingOperationError, BrowserRecordingStartCancelledError, BrowserRecordingUnavailableError, activeRecordings, captureTabMediaStreamWithTimeout, cleanupFailedRecordingStart, clearActiveRecording, createMediaRecorder, findActiveBrowserRecordingRuntimeTabId, isBrowserRecordingCaptureTimeoutError, isBrowserRecordingOperationError, isRecordingStarting, makeStartingBrowserRecordingLifecycle, prepareTabMediaCapture, publishActiveRecordingTabIds, queueDisplayMediaGrant, recordingStartupCancelledError, waitForBrowserRecordingPaint } from "./browserRecording";
import type { ActiveRecording } from "./browserRecording";

export const isStartupWaitTimeout = (error: unknown): error is BrowserRecordingOperationError =>
  isBrowserRecordingOperationError(error) && error.operation === "wait-startup";

export async function startBrowserRecording(
  tabId: string,
  threadRef: ScopedThreadRef | null = null,
  serverTabId = tabId,
): Promise<string> {
  const bridge = previewBridge;
  if (!bridge) throw new BrowserRecordingUnavailableError({ tabId });
  const activeRecording = activeRecordings.get(tabId);
  if (activeRecording) {
    if (activeRecording.lifecycle.phase === "recording") {
      return activeRecording.startedAt;
    }
    throw new BrowserRecordingConflictError({
      requestedTabId: tabId,
      activeTabId: activeRecording.tabId,
    });
  }
  const activeLogicalRecording =
    threadRef === null ? null : findActiveBrowserRecordingRuntimeTabId(threadRef, serverTabId);
  if (activeLogicalRecording !== null) {
    throw new BrowserRecordingConflictError({
      requestedTabId: tabId,
      activeTabId: activeLogicalRecording,
    });
  }
  const startedAt = new Date().toISOString();
  const chunks: Blob[] = [];
  let settleStartup: (() => void) | undefined;
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });
  const startingLifecycle = makeStartingBrowserRecordingLifecycle();
  const releaseSurfaceActivity = acquireBrowserSurfaceActivity(tabId);
  const recording: ActiveRecording = {
    tabId,
    serverTabId,
    threadRef,
    chunks,
    startedAt,
    startupSettled,
    releaseSurfaceActivity,
    stream: null,
    recorder: null,
    compositor: null,
    lifecycle: startingLifecycle,
  };
  activeRecordings.set(tabId, recording);
  publishActiveRecordingTabIds();
  try {
    await ensureClientSettingsHydrated().catch((cause: unknown) => {
      clearActiveRecording(recording);
      throw cause;
    });
    const settings = getClientSettings();
    const frameRate = settings.browserRecordingFrameRate;
    await waitForBrowserRecordingPaint();
    const throwIfStartupCancelled = async (): Promise<void> => {
      if (activeRecordings.get(tabId) === recording) return;
      try {
        await bridge.recording.stopScreencast(tabId);
      } catch (cause) {
        throw recordingStartupCancelledError(
          recording,
          new AggregateError(
            [new Error(`Browser recording startup was cancelled for tab ${tabId}.`), cause],
            `Browser recording startup cancellation failed for tab ${tabId}.`,
            { cause },
          ),
        );
      }
      throw recordingStartupCancelledError(recording);
    };
    // Electron grants one display-media request at a time; serialize handoff, not recording.
    const grant = queueDisplayMediaGrant(async () => {
      if (startingLifecycle.cancelledBeforeGrant) {
        throw new BrowserRecordingStartCancelledError({ tabId });
      }
      startingLifecycle.grantStarted = true;
      await throwIfStartupCancelled();
      const capture = prepareTabMediaCapture(tabId, frameRate);
      try {
        await bridge.recording.startScreencast(tabId);
      } catch (cause) {
        capture.cancel();
        if (!isRecordingStarting(recording)) {
          throw recordingStartupCancelledError(recording, cause);
        }
        clearActiveRecording(recording);
        throw new BrowserRecordingOperationError({
          operation: "start-screencast",
          tabId,
          cause,
        });
      }
      try {
        await throwIfStartupCancelled();
      } catch (cause) {
        capture.cancel();
        throw cause;
      }
      try {
        recording.stream = await captureTabMediaStreamWithTimeout(tabId, capture.capturePromise);
        return recording.stream;
      } catch (cause) {
        const cleanupCause = await cleanupFailedRecordingStart(bridge, recording);
        if (isBrowserRecordingCaptureTimeoutError(cause) && cleanupCause === undefined) throw cause;
        throw new BrowserRecordingOperationError({
          operation: "capture-media-stream",
          tabId,
          cause:
            cleanupCause === undefined
              ? cause
              : new AggregateError(
                  [cause, cleanupCause],
                  `Browser media capture and cleanup failed for tab ${tabId}.`,
                  { cause },
                ),
        });
      }
    });
    startingLifecycle.setQueuedForGrant(grant.queued);
    const stream = await Promise.race([
      grant.result,
      startingLifecycle.cancelledBeforeGrantSignal.then(() => {
        throw new BrowserRecordingStartCancelledError({ tabId });
      }),
    ]);
    await throwIfStartupCancelled();

    let recorder: MediaRecorder;
    try {
      recording.compositor = await createRecordingCompositor(
        stream,
        {
          showKeyPresses: settings.browserRecordingShowKeyPresses,
          showMousePresses: settings.browserRecordingShowMousePresses,
          frameRate,
        },
        (listener) =>
          bridge.recording.onInput((event) => {
            if (event.tabId === tabId) listener(event.input);
          }),
      );
      recorder = createMediaRecorder(recording.compositor?.stream ?? stream);
      recording.recorder = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
    } catch (cause) {
      const cleanupCause = await cleanupFailedRecordingStart(bridge, recording);
      throw new BrowserRecordingOperationError({
        operation: "initialize-media-recorder",
        tabId,
        cause:
          cleanupCause === undefined
            ? cause
            : new AggregateError(
                [cause, cleanupCause],
                `Browser recording initialization and cleanup failed for tab ${tabId}.`,
                { cause },
              ),
      });
    }
    try {
      recorder.start(1_000);
    } catch (cause) {
      const cleanupCause = await cleanupFailedRecordingStart(bridge, recording);
      throw new BrowserRecordingOperationError({
        operation: "start-media-recorder",
        tabId,
        cause:
          cleanupCause === undefined
            ? cause
            : new AggregateError(
                [cause, cleanupCause],
                `Browser media recorder start and cleanup failed for tab ${tabId}.`,
                { cause },
              ),
      });
    }
    if (recording.lifecycle.phase === "starting") {
      recording.lifecycle = { phase: "recording" };
    }
    return startedAt;
  } finally {
    settleStartup?.();
  }
}

