import { describe, expect, it } from "vite-plus/test";
import { voiceInputFreezesEditor } from "@t3tools/client-runtime/voice-input";

import { resolveVoiceComposerPresentation } from "./voiceInputPresentation";

describe("resolveVoiceComposerPresentation", () => {
  it("maps voice states to stable composer actions and editor read-only state", () => {
    expect(
      resolveVoiceComposerPresentation({ phase: "idle", error: null, errorAction: null }, 0),
    ).toEqual({
      leadingAction: null,
      trailingAction: "mic",
      showsSend: true,
      statusKind: null,
      statusLabel: null,
      confirmationEnabled: false,
    });
    expect(
      resolveVoiceComposerPresentation({ phase: "preparing", error: null, errorAction: null }, 0),
    ).toMatchObject({
      leadingAction: "cancel",
      trailingAction: "confirm",
      showsSend: false,
      statusLabel: "Preparing",
      confirmationEnabled: false,
    });
    expect(
      resolveVoiceComposerPresentation({ phase: "recording", error: null, errorAction: null }, 64),
    ).toMatchObject({
      leadingAction: "cancel",
      trailingAction: "confirm",
      showsSend: false,
      statusLabel: "Recording 1:04",
      confirmationEnabled: true,
    });
    expect(
      resolveVoiceComposerPresentation(
        { phase: "transcribing", error: null, errorAction: null },
        0,
      ),
    ).toMatchObject({
      statusLabel: "Transcribing",
      confirmationEnabled: false,
    });
    expect(
      resolveVoiceComposerPresentation(
        { phase: "error", error: "Microphone unavailable", errorAction: "retry" },
        0,
      ),
    ).toMatchObject({
      leadingAction: null,
      trailingAction: "mic",
      showsSend: true,
      statusKind: "error",
      statusLabel: "Microphone unavailable",
    });

    expect(voiceInputFreezesEditor({ phase: "preparing", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputFreezesEditor({ phase: "recording", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputFreezesEditor({ phase: "transcribing", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputFreezesEditor({ phase: "idle", error: null, errorAction: null })).toBe(false);
  });
});
