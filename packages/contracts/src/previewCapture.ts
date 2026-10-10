import * as Schema from "effect/Schema";

export const PreviewCaptureDiagnostic = Schema.Struct({
  reason: Schema.Literals([
    "renderer-unavailable",
    "capture-unavailable",
    "capture-timeout",
    "recording-conflict",
    "capture-failed",
  ]),
  stage: Schema.Literals(["screenshot", "capture-page", "recording-start"]),
});
export type PreviewCaptureDiagnostic = typeof PreviewCaptureDiagnostic.Type;

function previewCaptureFailureMessage(diagnostic: PreviewCaptureDiagnostic): string {
  switch (diagnostic.reason) {
    case "renderer-unavailable":
      return "The preview renderer is unavailable. Reopen the preview tab before retrying.";
    case "capture-unavailable":
      return "The preview capture surface is unavailable. Present the target tab before retrying.";
    case "capture-timeout":
      return `Preview capture timed out during ${diagnostic.stage}. Check the preview host's lock, display and window state before retrying.`;
    case "recording-conflict":
      return "A recording capture is already starting, stopping or active. Wait for it to settle, or stop the active recording before retrying.";
    case "capture-failed":
      return `Preview capture failed during ${diagnostic.stage}. Check the preview host and target tab before retrying.`;
  }
}

/** A plain encoded failure crosses IPC and contextBridge without an arbitrary Error or stack. */
export class PreviewCaptureFailure extends Schema.TaggedError<PreviewCaptureFailure>()(
  "PreviewCaptureFailure",
  PreviewCaptureDiagnostic.fields,
) {
  override get message(): string {
    return previewCaptureFailureMessage(this);
  }
}
