import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export type VoiceComposerPresentation = {
  readonly leadingAction: "cancel" | null;
  readonly trailingAction: "mic" | "confirm";
  readonly showsSend: boolean;
  readonly showsDictationSend: boolean;
  readonly statusKind: "active" | "error" | null;
  readonly statusLabel: string | null;
  readonly confirmationEnabled: boolean;
};

export function resolveVoiceComposerPresentation(
  state: VoiceInputState,
  elapsedSeconds: number,
  resolve: MessageResolver = m,
): VoiceComposerPresentation {
  switch (state.phase) {
    case "idle":
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        showsDictationSend: false,
        statusKind: null,
        statusLabel: null,
        confirmationEnabled: false,
      };
    case "error":
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        showsDictationSend: false,
        statusKind: "error",
        statusLabel: state.error,
        confirmationEnabled: false,
      };
    case "preparing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        showsDictationSend: true,
        statusKind: "active",
        statusLabel: resolve(msg("Preparing", { $context: "voice input status" })),
        confirmationEnabled: false,
      };
    case "recording": {
      const seconds = Math.max(0, Math.floor(elapsedSeconds));
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        showsDictationSend: true,
        statusKind: "active",
        statusLabel: resolve(
          msg("Recording {time}", {
            time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
          }),
        ),
        confirmationEnabled: true,
      };
    }
    case "transcribing":
    case "post-processing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        showsDictationSend: false,
        statusKind: "active",
        statusLabel: resolve(msg("Transcribing", { $context: "voice input status" })),
        confirmationEnabled: false,
      };
  }
}

export type PendingVoiceSendAction = "send" | "clear" | "wait";

/**
 * Decides what a stop-and-send tap does once dictation settles. Idle alone is not enough:
 * cancelling during transcription also lands in idle, so only a committed transcript sends.
 * A send applies only to the draft the tap targeted.
 */
export function resolvePendingVoiceSend(input: {
  readonly pending: boolean;
  readonly committed: boolean;
  /** False once the composer shows a different draft than the one the tap targeted. */
  readonly targetsCurrentDraft: boolean;
  readonly phase: VoiceInputState["phase"];
  readonly canSend: boolean;
}): PendingVoiceSendAction {
  if (!input.pending) return "wait";
  if (!input.targetsCurrentDraft) return "clear";
  if (input.phase === "error") return "clear";
  if (input.phase !== "idle") return "wait";
  return input.committed && input.canSend ? "send" : "clear";
}
