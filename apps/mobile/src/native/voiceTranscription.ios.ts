import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { File } from "expo-file-system";

import { VoiceTranscriptionError } from "./voiceTranscription.types";

export { VoiceTranscriptionError } from "./voiceTranscription.types";
export type { VoiceTranscriptionErrorCode } from "./voiceTranscription.types";

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

export function isVoiceTranscriptionAvailable(): boolean {
  return AppleTranscription.isAvailable(getDeviceLocale());
}

export async function prepareVoiceTranscription(): Promise<string> {
  const locale = getDeviceLocale();
  if (!AppleTranscription.isAvailable(locale)) {
    throw new VoiceTranscriptionError(
      "unavailable",
      "Voice transcription requires a supported device with iOS 26 or later.",
    );
  }

  try {
    return await AppleTranscription.prepare(locale);
  } catch (error) {
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

export async function transcribeVoiceRecording(uri: string, locale: string): Promise<string> {
  try {
    const audio = await new File(uri).arrayBuffer();
    const result = await AppleTranscription.transcribe(audio, locale);
    return result.segments
      .map((segment) => segment.text)
      .join(" ")
      .trim();
  } catch (error) {
    throw wrapError("transcription-failed", "Voice transcription failed.", error);
  }
}
