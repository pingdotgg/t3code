import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type VoiceRecorder,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type { DesktopBridge } from "@t3tools/contracts";

type DesktopSpeechBridge = NonNullable<DesktopBridge["speech"]>;

function wrapTranscriptionError(
  code: "preparation-failed" | "transcription-failed",
  message: string,
  cause: unknown,
): VoiceTranscriptionError {
  if (cause instanceof VoiceTranscriptionError) return cause;
  return new VoiceTranscriptionError(code, message, { cause });
}

export function createDesktopVoiceInputPlatform(bridge: DesktopSpeechBridge): {
  readonly recorder: VoiceRecorder;
  readonly transcriber: VoiceTranscriber;
  readonly setDurationLimitHandler: (handler: () => void) => void;
} {
  let recordingUri: string | null = null;
  let recordingStarted = false;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let stopAtDurationLimit = () => {};

  const recorder: VoiceRecorder = {
    get uri() {
      return recordingUri;
    },
    prepareToRecordAsync: async () => {
      recordingUri = null;
      await bridge.startRecording();
      recordingStarted = true;
    },
    record: ({ forDuration }) => {
      durationTimer = setTimeout(stopAtDurationLimit, forDuration * 1_000);
    },
    stop: async () => {
      if (durationTimer !== undefined) clearTimeout(durationTimer);
      durationTimer = undefined;
      if (!recordingStarted) return;
      recordingStarted = false;
      recordingUri = await bridge.stopRecording();
    },
  };

  const transcriber: VoiceTranscriber = {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      const cancel = () => void bridge.cancelPreparation();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const prepared = await bridge.prepare();
        throwIfVoiceTranscriptionAborted(signal);
        return {
          locale: prepared.locale,
          transcribe: async (uri, options) => {
            try {
              throwIfVoiceTranscriptionAborted(options.signal);
              const transcript = await bridge.transcribe(uri);
              throwIfVoiceTranscriptionAborted(options.signal);
              return transcript;
            } catch (error) {
              throwIfVoiceTranscriptionAborted(options.signal);
              throw wrapTranscriptionError(
                "transcription-failed",
                "Local voice transcription failed.",
                error,
              );
            }
          },
        };
      } catch (error) {
        throwIfVoiceTranscriptionAborted(signal);
        throw wrapTranscriptionError(
          "preparation-failed",
          "Local voice transcription could not be prepared.",
          error,
        );
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  };

  return {
    recorder,
    transcriber,
    setDurationLimitHandler: (handler) => {
      stopAtDurationLimit = handler;
    },
  };
}
