import { PreviewCaptureFailure, type PreviewCaptureDiagnostic } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

const isNativeFailure = Schema.is(
  Schema.Struct({
    _tag: Schema.String,
    operation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  }),
);

/** Classify before Electron replaces a rejected IPC Error with its message. */
export function normalizeCaptureFailure(
  error: unknown,
  stage: PreviewCaptureDiagnostic["stage"],
): PreviewCaptureFailure {
  let reason: PreviewCaptureDiagnostic["reason"] = "capture-failed";
  if (isNativeFailure(error)) {
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
  }
  return new PreviewCaptureFailure({ reason, stage });
}
