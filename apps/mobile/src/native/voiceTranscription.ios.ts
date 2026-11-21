import * as Schema from "effect/Schema";
import { requireOptionalNativeModule } from "expo";
import { msg } from "gt-react-native";
import { Settings } from "react-native";
import { m } from "../i18n/messages";

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

interface AppleSpeechModule {
  isAppleSpeechAvailable?: () => boolean;
  prepareAppleSpeech: (locale: string) => Promise<string | null>;
  transcribeWithAppleSpeech: (uri: string, locale: string) => Promise<string>;
}

const native = requireOptionalNativeModule<AppleSpeechModule>("T3VoiceTranscription");
const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);

/** The user's ordered Language & Region list, then the app locale; the app ships in English only. */
function getPreferredLocales(): string[] {
  const languages: unknown = Settings.get("AppleLanguages");
  const preferred = Array.isArray(languages)
    ? languages.filter(
        (language): language is string => typeof language === "string" && language.length > 0,
      )
    : [];
  return [...new Set([...preferred, Intl.DateTimeFormat().resolvedOptions().locale])];
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
  const locales = getPreferredLocales();
  // Availability is a device and OS check; which languages have a model only `prepare` knows.
  if (!isVoiceStreamingAvailable() && !native?.isAppleSpeechAvailable?.()) return null;
  return { prepare: (options) => prepareVoiceTranscription(locales, options) };
}

/** Prefers live capture, keeping file transcription for when it cannot start. */
async function prepareVoiceTranscription(
  locales: readonly string[],
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  if (isVoiceStreamingAvailable()) {
    try {
      const supportedLocale = await firstSupportedLocale(locales, (locale) =>
        prepareVoiceStreaming(locale, { signal }),
      );
      return {
        locale: supportedLocale,
        startStreaming: (options) =>
          startVoiceStreaming(supportedLocale, VOICE_RECORDING_LIMIT_SECONDS, options),
        prepareFileFallback: native?.isAppleSpeechAvailable?.()
          ? (options) => prepareFileVoiceTranscription(locales, options)
          : undefined,
        transcribe: (uri, options) => transcribeVoiceRecording(uri, supportedLocale, options),
      };
    } catch (error) {
      throwIfVoiceTranscriptionAborted(signal);
      if (!native?.isAppleSpeechAvailable?.()) throw mapPreparationError(error);
    }
  }

  return prepareFileVoiceTranscription(locales, { signal });
}

async function prepareFileVoiceTranscription(
  locales: readonly string[],
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  if (!native?.isAppleSpeechAvailable?.()) {
    throw new VoiceTranscriptionError({
      code: "unavailable",
      message: m(
        msg("Voice transcription requires a supported device with {platform} or later.", {
          platform: "iOS 26",
        }),
      ),
    });
  }

  let locale = locales[0]!;
  const model = firstSupportedLocale(locales, (candidate) =>
    prepareLocale(native, candidate, signal),
  ).then((supported) => {
    locale = supported;
  });
  // Recorder setup can fail before either consumer observes the model.
  void model.catch(() => {});

  async function ready(signal: AbortSignal) {
    throwIfVoiceTranscriptionAborted(signal);
    const cancelled = Promise.withResolvers<void>();
    const cancel = () => cancelled.resolve();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await Promise.race([model, cancelled.promise]);
      throwIfVoiceTranscriptionAborted(signal);
      return locale;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  return {
    get locale() {
      return locale;
    },
    start: async (_uri, { signal }) => {
      await ready(signal);
      return null;
    },
    transcribe: async (uri, options) =>
      transcribeVoiceRecording(uri, await ready(options.signal), options),
  };
}

/** Tries each preferred language in order, skipping ones without a model. */
async function firstSupportedLocale(
  locales: readonly string[],
  prepare: (locale: string) => Promise<string>,
): Promise<string> {
  let unsupported: VoiceTranscriptionError | undefined;
  for (const locale of locales) {
    try {
      return await prepare(locale);
    } catch (error) {
      if (!isVoiceTranscriptionError(error) || error.code !== "unsupported-locale") throw error;
      unsupported = error;
    }
  }
  throw unsupported!;
}

async function prepareLocale(
  native: AppleSpeechModule,
  locale: string,
  signal: AbortSignal,
): Promise<string> {
  let supportedLocale: string | null;
  try {
    supportedLocale = await native.prepareAppleSpeech(locale);
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw mapPreparationError(error);
  }
  throwIfVoiceTranscriptionAborted(signal);
  if (supportedLocale === null) {
    throw new VoiceTranscriptionError({
      code: "unsupported-locale",
      message: m(msg("Voice transcription does not support any of your languages.")),
    });
  }
  return supportedLocale;
}

function mapPreparationError(error: unknown): VoiceTranscriptionError {
  if (isVoiceTranscriptionError(error)) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "AppleTranscriptionUnsupportedLocale") {
    return new VoiceTranscriptionError({
      code: "unsupported-locale",
      message: m(msg("Voice transcription does not support any of your languages.")),
      cause: error,
    });
  }
  const nativeError = mapNativeVoiceError(error, "preparation");
  if (isVoiceTranscriptionError(nativeError)) return nativeError;
  return wrapError(
    "preparation-failed",
    m(msg("Voice transcription could not prepare this language.")),
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
    if (!native?.isAppleSpeechAvailable?.()) {
      throw new VoiceTranscriptionError({
        code: "unavailable",
        message: m(
          msg("Voice transcription requires a supported device with {platform} or later.", {
            platform: "iOS 26",
          }),
        ),
      });
    }
    const text = await native.transcribeWithAppleSpeech(uri, locale);
    throwIfVoiceTranscriptionAborted(signal);
    return text;
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError("transcription-failed", m(msg("Voice transcription failed.")), error);
  }
}
