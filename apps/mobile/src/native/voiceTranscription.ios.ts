import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { File } from "expo-file-system";
import { Settings } from "react-native";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

/**
 * The app only ships English, so its locale is e.g. "en-DE" on a German iPhone.
 * Speech follows the user's preferred languages instead (`AppleLanguages` holds
 * the same list as `Locale.preferredLanguages`), falling back to the app locale.
 */
function getPreferredLocales(): string[] {
  const languages = Settings.get("AppleLanguages");
  const preferred = Array.isArray(languages)
    ? languages.filter((language): language is string => typeof language === "string")
    : [];
  return [...new Set([...preferred, Intl.DateTimeFormat().resolvedOptions().locale])];
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
  const locales = getPreferredLocales();
  if (!AppleTranscription.isAvailable(locales[0]!)) return null;
  return { prepare: (options) => prepareVoiceTranscription(locales, options) };
}

async function prepareVoiceTranscription(
  locales: readonly string[],
  options: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  for (const locale of locales.slice(0, -1)) {
    try {
      return await prepareLocale(locale, options);
    } catch (error) {
      if (!(error instanceof VoiceTranscriptionError && error.code === "unsupported-locale")) {
        throw error;
      }
    }
  }
  return prepareLocale(locales.at(-1)!, options);
}

async function prepareLocale(
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
    if (getNativeErrorCode(error) === "AppleTranscriptionUnsupportedLocale") {
      throw new VoiceTranscriptionError(
        "unsupported-locale",
        "Voice transcription does not support this device language.",
        { cause: error },
      );
    }

    throw wrapError(
      "preparation-failed",
      "Voice transcription could not prepare this language.",
      error,
    );
  }
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
