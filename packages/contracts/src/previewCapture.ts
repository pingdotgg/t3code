import * as Schema from "effect/Schema";
import { msg } from "gt-i18n";
import { errorMessage } from "./errorMessage.ts";

/** A plain encoded failure crosses IPC and contextBridge without an arbitrary Error or stack. */
export class PreviewCaptureFailure extends Schema.TaggedError<PreviewCaptureFailure>()(
  "PreviewCaptureFailure",
  {
    reason: Schema.Literals([
      "renderer-unavailable",
      "capture-unavailable",
      "capture-timeout",
      "recording-conflict",
      "capture-failed",
    ]),
    stage: Schema.Literals(["screenshot", "capture-page", "recording-start"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "renderer-unavailable":
        return errorMessage(
          msg("The preview renderer is unavailable. Reopen the preview tab before retrying."),
        );
      case "capture-unavailable":
        return errorMessage(
          msg(
            "The preview capture surface is unavailable. Present the target tab and check that the preview host is unlocked, its display is on and its window is restored before retrying.",
          ),
        );
      case "capture-timeout":
        return errorMessage(
          msg(
            "Preview capture timed out during {stage}. Check the preview host's lock, display and window state before retrying.",
            { stage: this.stage },
          ),
        );
      case "recording-conflict":
        return errorMessage(
          msg(
            "A recording capture is already starting, stopping or active. Wait for it to settle, or stop the active recording before retrying.",
          ),
        );
      case "capture-failed":
        return errorMessage(
          msg(
            "Preview capture failed during {stage}. Check the preview host and target tab before retrying.",
            { stage: this.stage },
          ),
        );
    }
  }
}

export type PreviewCaptureFailureEncoded = Schema.Codec.Encoded<typeof PreviewCaptureFailure>;
