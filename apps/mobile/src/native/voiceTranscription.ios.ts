import * as Schema from "effect/Schema";
import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { File } from "expo-file-system";

import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

import {
  isVoiceStreamingAvailable,
  mapNativeVoiceError,
  prepareVoiceStreaming,
  startVoiceStreaming,
} from "./voiceStreaming.ios";

const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);

function getDeviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function wrapError(
  code: "preparation-failed" | "transcription-failed",
  message: string,
  cause: unknown,
): VoiceTranscriptionError {
  if (isVoiceTranscriptionError(cause)) {
    return cause;
  }

  return new VoiceTranscriptionError({ code, message, cause });
}

export async function getLocalVoiceTranscriber(): Promise<VoiceTranscriber | null> {
  const locale = getDeviceLocale();
  if (!isVoiceStreamingAvailable() && !AppleTranscription.isAvailable(locale)) return null;
  return { prepare: (options) => prepareVoiceTranscription(locale, options) };
}

/** Prefers live capture, keeping file transcription for when it cannot start. */
async function prepareVoiceTranscription(
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  if (isVoiceStreamingAvailable()) {
    try {
      const supportedLocale = await prepareVoiceStreaming(locale, { signal });
      return {
        locale: supportedLocale,
        startStreaming: (options) =>
          startVoiceStreaming(supportedLocale, VOICE_RECORDING_LIMIT_SECONDS, options),
        prepareFileFallback: AppleTranscription.isAvailable(locale)
          ? (options) => prepareFileVoiceTranscription(locale, options)
          : undefined,
        transcribe: (uri, options) => transcribeVoiceRecording(uri, supportedLocale, options),
      };
    } catch (error) {
      throwIfVoiceTranscriptionAborted(signal);
      if (!AppleTranscription.isAvailable(locale)) throw mapPreparationError(error);
    }
  }

  return prepareFileVoiceTranscription(locale, { signal });
}

async function prepareFileVoiceTranscription(
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  if (!AppleTranscription.isAvailable(locale)) {
    throw new VoiceTranscriptionError({
      code: "unavailable",
      message: "Voice transcription requires a supported device with iOS 26 or later.",
    });
  }

  try {
    const supportedLocale = await AppleTranscription.prepare(locale);
    throwIfVoiceTranscriptionAborted(signal);
    return {
      locale: supportedLocale,
      transcribe: (uri, options) => transcribeVoiceRecording(uri, supportedLocale, options),
    };
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw mapPreparationError(error);
  }
}

function mapPreparationError(error: unknown): VoiceTranscriptionError {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "AppleTranscriptionUnsupportedLocale") {
    return new VoiceTranscriptionError({
      code: "unsupported-locale",
      message: "Voice transcription does not support this device language.",
      cause: error,
    });
  }
  const nativeError = mapNativeVoiceError(error, "preparation");
  if (isVoiceTranscriptionError(nativeError)) return nativeError;
  return wrapError(
    "preparation-failed",
    "Voice transcription could not prepare this language.",
    error,
  );
}

async function transcribeVoiceRecording(
  uri: string,
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  try {
    throwIfVoiceTranscriptionAborted(signal);
    const audio = await new File(uri).arrayBuffer();
    throwIfVoiceTranscriptionAborted(signal);
    const result = await AppleTranscription.transcribe(audio, locale);
    throwIfVoiceTranscriptionAborted(signal);
    return result.segments
      .map((segment) => segment.text)
      .join(" ")
      .trim();
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError("transcription-failed", "Voice transcription failed.", error);
  }
}
