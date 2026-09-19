import { VoiceInputController, type VoiceInputState } from "@t3tools/client-runtime/voice-input";
import type { ProviderDriverKind } from "@t3tools/contracts";
import { formatSpokenPunctuation } from "@t3tools/shared/voicePunctuation";

export type ComposerVoiceDraft = {
  readonly ownerKey: string;
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
};

export type ComposerVoiceCommit = {
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly insertion: string;
  readonly expectedText: string;
};

export type ComposerVoiceRecorderCallbacks = {
  readonly onError: (error: Error) => void;
  readonly onTranscript: (text: string) => void;
};

export type ComposerVoiceRecorder = {
  start(): void | Promise<void>;
  stop(): Promise<ComposerVoiceTranscript>;
  dispose(): void;
};

export type ComposerVoiceTranscript = { readonly text: string; readonly locale: string };

export type ComposerVoiceSessionDependencies = {
  readonly readDraft: () => ComposerVoiceDraft | null;
  readonly commitDraft: (commit: ComposerVoiceCommit) => boolean;
  readonly requestMicrophone: () => Promise<MediaStream>;
  readonly createRecorder: (
    stream: Promise<MediaStream>,
    callbacks: ComposerVoiceRecorderCallbacks,
  ) => ComposerVoiceRecorder;
  readonly onStateChange: (state: VoiceInputState) => void;
  readonly onComplete?: (draft: ComposerVoiceDraft) => void;
  readonly now?: () => number;
  readonly formatTranscript?: (text: string) => string;
};

export const IDLE_COMPOSER_VOICE_STATE: VoiceInputState = {
  phase: "idle",
  error: null,
  errorAction: null,
};

export const VOICE_BUSY_SEND_DISABLED_REASON = "Finish voice input before sending";

export const VOICE_NON_CODEX_DISABLED_REASON = "Voice input is unavailable for this provider";

export const VOICE_CODEX_LOGIN_DISABLED_REASON = "Sign in with `codex login`";

export const VOICE_COMPOSER_BUSY_DISABLED_REASON =
  "Voice input is unavailable while the composer is busy";

export function resolveVoiceSendDisabledReason(input: {
  readonly external: string | null;
  readonly voiceBusy: boolean;
  readonly fallback: string | null;
}) {
  return (
    input.external ?? (input.voiceBusy ? VOICE_BUSY_SEND_DISABLED_REASON : null) ?? input.fallback
  );
}

export function resolveVoiceMicAvailability(input: {
  readonly driverKind: ProviderDriverKind;
  readonly codexVoiceAvailable: boolean;
  readonly composerDisabled: boolean;
}) {
  if (input.driverKind !== "codex") {
    return { available: false, reason: VOICE_NON_CODEX_DISABLED_REASON } as const;
  }
  if (!input.codexVoiceAvailable) {
    return { available: false, reason: VOICE_CODEX_LOGIN_DISABLED_REASON } as const;
  }
  if (input.composerDisabled) {
    return { available: false, reason: VOICE_COMPOSER_BUSY_DISABLED_REASON } as const;
  }
  return { available: true } as const;
}

export function formatVoiceElapsed(totalSeconds: number) {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, "0")}`;
}

export function requestComposerMicrophone(): Promise<MediaStream> {
  const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    return Promise.reject(new Error("Voice input is not supported in this browser."));
  }
  return mediaDevices.getUserMedia({ audio: true });
}

/** Browser microphone/recorder adapter; lifecycle and draft ownership live in VoiceInputController. */
export class ComposerVoiceSession extends VoiceInputController {
  constructor(dependencies: ComposerVoiceSessionDependencies) {
    let revision = 0;
    let lastSeen: { ownerKey: string; text: string } | null = null;
    super({
      mode: "streaming",
      readDraft: () => {
        const raw = dependencies.readDraft();
        if (!raw) return null;
        if (!lastSeen || lastSeen.ownerKey !== raw.ownerKey || lastSeen.text !== raw.text) {
          revision++;
          lastSeen = raw;
        }
        const start = Math.max(0, Math.min(raw.text.length, raw.selectionStart));
        return {
          ownerKey: raw.ownerKey,
          text: raw.text,
          revision,
          selection: { start, end: Math.max(start, Math.min(raw.text.length, raw.selectionEnd)) },
        };
      },
      commitDraft: (_text, _selection, change) =>
        change ? dependencies.commitDraft(change) : false,
      onStateChange: dependencies.onStateChange,
      onComplete: (draft) =>
        dependencies.onComplete?.({
          ownerKey: draft.ownerKey,
          text: draft.text,
          selectionStart: 0,
          selectionEnd: draft.text.length,
        }),
      now: dependencies.now ?? Date.now,
      formatTranscript: dependencies.formatTranscript ?? formatSpokenPunctuation,
      createRecorder: (callbacks) => {
        let disposed = false;
        let stream: MediaStream | null = null;
        let recorder: ComposerVoiceRecorder | null = null;
        const release = () => {
          disposed = true;
          try {
            recorder?.dispose();
          } finally {
            for (const track of stream?.getTracks() ?? []) {
              try {
                track.stop();
              } catch {
                /* The device may already be gone. */
              }
            }
            stream = null;
          }
        };
        const microphone = dependencies.requestMicrophone().then((capture) => {
          if (disposed) {
            for (const track of capture.getTracks()) track.stop();
            throw new Error("Voice input was cancelled.");
          }
          stream = capture;
          return capture;
        });
        void microphone.catch(() => {});
        try {
          recorder = dependencies.createRecorder(microphone, callbacks);
        } catch (error) {
          release();
          throw error;
        }
        return {
          start: async () => {
            await Promise.all([recorder!.start(), microphone]);
          },
          stop: () => recorder!.stop(),
          dispose: release,
        };
      },
    });
  }
}
