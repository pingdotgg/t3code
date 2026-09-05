import {
  isVoiceStreamingAvailable,
  prepareVoiceStreaming,
  startVoiceStreaming,
} from "./voiceStreaming.ios";
import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { File } from "expo-file-system";

import {
  VoiceTranscriptionError,
  VOICE_RECORDING_LIMIT_SECONDS,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

function getDeviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function wrapError(
  code: "preparation-failed" | "transcription-failed",
  message: string,
  cause: unknown,
): VoiceTranscriptionError {
  if (cause instanceof VoiceTranscriptionError) {
    return cause;
  }

  return new VoiceTranscriptionError(code, message, { cause });
}

function getNativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  const locale = getDeviceLocale();
  if (!isVoiceStreamingAvailable() && !AppleTranscription.isAvailable(locale)) return null;
  return { prepare: (options) => prepareVoiceTranscription(locale, options) };
}

async function prepareVoiceTranscription(
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  if (isVoiceStreamingAvailable()) {
    try {
      const supportedLocale = await prepareVoiceStreaming(locale, { signal });
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale: supportedLocale,
        prepareFileFallback: AppleTranscription.isAvailable(locale)
          ? (options) => prepareFileVoiceTranscription(locale, options)
          : undefined,
        startStreaming: (options) =>
          startVoiceStreaming(supportedLocale, VOICE_RECORDING_LIMIT_SECONDS, options),
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
    throw new VoiceTranscriptionError(
      "unavailable",
      "Voice transcription requires a supported device with iOS 26 or later.",
    );
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
  if (getNativeErrorCode(error) === "AppleTranscriptionUnsupportedLocale") {
    return new VoiceTranscriptionError(
      "unsupported-locale",
      "Voice transcription does not support this device language.",
      { cause: error },
    );
  }

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
