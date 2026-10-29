import { requireOptionalNativeModule } from "expo";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

type PreparedGoogleTranscription = { readonly locale: string; readonly mode: number };

const native = requireOptionalNativeModule<{
  isAvailable(): boolean;
  prepare(id: number): Promise<PreparedGoogleTranscription>;
  transcribe(id: number, uri: string, locale: string, mode: number): Promise<string>;
  cancel(id: number): Promise<void>;
}>("T3VoiceTranscription");

let nextOperationId = 0;

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  if (!native?.isAvailable()) return null;
  const module = native;
  return {
    prepare: async ({ signal }) => {
      const prepared = await runOperation(signal, "preparation-failed", (id) => module.prepare(id));
      return {
        locale: prepared.locale,
        transcribe: (uri, { signal }) =>
          runOperation(signal, "transcription-failed", (id) =>
            module.transcribe(id, uri, prepared.locale, prepared.mode),
          ),
      };
    },
  };
}

async function runOperation<T>(
  signal: AbortSignal,
  errorCode: "preparation-failed" | "transcription-failed",
  operation: (id: number) => Promise<T>,
): Promise<T> {
  throwIfVoiceTranscriptionAborted(signal);
  const id = ++nextOperationId;
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation = native!.cancel(id).catch(() => {});
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
    throw new VoiceTranscriptionError(
      code === "unavailable" || code === "unsupported-locale" ? code : errorCode,
      code === "unavailable"
        ? "On-device voice transcription is not available for this device language."
        : errorCode === "preparation-failed"
          ? "Voice transcription could not prepare this language. Check Google speech services and try again."
          : "Voice transcription failed.",
      { cause: error },
    );
  } finally {
    signal.removeEventListener("abort", abort);
    await cancellation;
  }
}
