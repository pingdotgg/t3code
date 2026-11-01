import { PreviewCaptureFailure } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { PreviewManagerError } from "./Manager.ts";

/** Classify before Electron replaces a rejected IPC Error with its message. */
export function normalizeCaptureFailure(
  error: PreviewManagerError,
  stage: PreviewCaptureFailure["stage"],
): PreviewCaptureFailure {
  let reason: PreviewCaptureFailure["reason"] = "capture-failed";
  switch (error._tag) {
    case "PreviewTabNotFoundError":
    case "PreviewWebContentsNotFoundError":
    case "PreviewMainWindowClosedError":
      reason = "renderer-unavailable";
      break;
    case "PreviewWebviewNotInitializedError":
    case "PreviewRecordingCaptureUnavailableError":
      reason = "capture-unavailable";
      break;
    case "PreviewRecordingArmConflictError":
      reason = "recording-conflict";
      break;
    case "PreviewOperationError":
      if (error.operation === "captureScreenshot.capturePage") {
        stage = "capture-page";
        if (
          error.cause instanceof Error &&
          error.cause.message === "Current display surface not available for capture"
        ) {
          reason = "capture-unavailable";
        }
      }
      if (Cause.isTimeoutError(error.cause)) reason = "capture-timeout";
      break;
  }
  return new PreviewCaptureFailure({ reason, stage });
}
