import { requireOptionalNativeModule } from "expo";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

type PreparedGoogleTranscription = { readonly locale: string; readonly mode: number };

type GoogleTranscriptionModule = {
  checkAvailability(): Promise<boolean>;
  prepare(id: number): Promise<PreparedGoogleTranscription>;
  transcribe(id: number, uri: string, locale: string, mode: number): Promise<string>;
  cancel(id: number): Promise<void>;
};

const native = requireOptionalNativeModule<GoogleTranscriptionModule>("T3VoiceTranscription");

const nativeErrorMessages: Readonly<Record<string, string>> = {
  unavailable: "On-device voice transcription is not available for this device language.",
  storage: "Not enough storage for on-device dictation. Free device storage and retry.",
  quota: "On-device speech quota reached. Let the device rest or charge it, then retry.",
  "no-speech": "No speech was detected. Speak again and retry dictation.",
  busy: "On-device speech is busy. Wait for it to finish, then retry dictation.",
  "needs-update": "Update Android and its on-device speech services, then retry dictation.",
  "download-failed": "Speech model download failed. Check your network connection and retry.",
  "audio-overflow":
    "The speech engine could not process the complete recording. No text was added. Retry dictation.",
  "incomplete-audio":
    "Speech recognition could not process the complete recording. No text was added. Retry dictation.",
};

let nextOperationId = 0;

export async function getLocalVoiceTranscriber(): Promise<VoiceTranscriber | null> {
  if (!native || !(await native.checkAvailability())) return null;
  const module = native;
  return {
    prepare: async ({ signal }) => {
      const prepared = await runOperation(module, signal, "preparation-failed", (id) =>
        module.prepare(id),
      );
      return {
        locale: prepared.locale,
        transcribe: (uri, { signal }) =>
          runOperation(module, signal, "transcription-failed", (id) =>
            module.transcribe(id, uri, prepared.locale, prepared.mode),
          ),
      };
    },
  };
}

async function runOperation<T>(
  module: GoogleTranscriptionModule,
  signal: AbortSignal,
  fallbackCode: "preparation-failed" | "transcription-failed",
  operation: (id: number) => Promise<T>,
): Promise<T> {
  throwIfVoiceTranscriptionAborted(signal);
  const id = ++nextOperationId;
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation = module.cancel(id).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await operation(id);
    throwIfVoiceTranscriptionAborted(signal);
    return result;
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    throw new VoiceTranscriptionError({
      code: code === "unavailable" || code === "unsupported-locale" ? code : fallbackCode,
      message:
        (typeof code === "string" ? nativeErrorMessages[code] : undefined) ??
        (fallbackCode === "preparation-failed"
          ? "Voice transcription could not prepare this language. Check Google speech services and try again."
          : "Voice transcription failed."),
      cause: error,
    });
  } finally {
    signal.removeEventListener("abort", abort);
    await cancellation;
  }
}
