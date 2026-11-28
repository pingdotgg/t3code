import * as Schema from "effect/Schema";
import { requireOptionalNativeModule } from "expo";
import { msg } from "gt-react-native";
import { Settings } from "react-native";
import { m } from "../i18n/messages";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

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
  if (!native?.isAppleSpeechAvailable?.()) return null;
  return { prepare: (options) => prepareVoiceTranscription(native, locales, false, options) };
}

/** A chosen language stays fixed: one the device can't transcribe fails instead of falling back. */
export function getVoiceTranscriberForLocale(locale: string): VoiceTranscriber | null {
  if (!native) return null;
  return { prepare: (options) => prepareVoiceTranscription(native, [locale], true, options) };
}

async function prepareVoiceTranscription(
  native: AppleSpeechModule,
  locales: readonly string[],
  chosen: boolean,
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
  const model = prepareLocales(native, locales, chosen, signal).then((supported) => {
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
      transcribeVoiceRecording(native, uri, await ready(options.signal), options),
  };
}

async function prepareLocales(
  native: AppleSpeechModule,
  locales: readonly string[],
  chosen: boolean,
  signal: AbortSignal,
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  let unsupported: VoiceTranscriptionError | undefined;
  for (const locale of locales) {
    try {
      return await prepareLocale(native, locale, chosen, signal);
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
  chosen: boolean,
  signal: AbortSignal,
): Promise<string> {
  let supportedLocale: string | null;
  try {
    supportedLocale = await native.prepareAppleSpeech(locale);
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError(
      "preparation-failed",
      m(msg("Voice transcription could not prepare this language.")),
      error,
    );
  }
  throwIfVoiceTranscriptionAborted(signal);
  if (supportedLocale === null) {
    throw new VoiceTranscriptionError({
      code: "unsupported-locale",
      message: chosen
        ? m(msg("Voice transcription does not support this language."))
        : m(msg("Voice transcription does not support any of your languages.")),
    });
  }
  return supportedLocale;
}

async function transcribeVoiceRecording(
  native: AppleSpeechModule,
  uri: string,
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  try {
    throwIfVoiceTranscriptionAborted(signal);
    const text = await native.transcribeWithAppleSpeech(uri, locale);
    throwIfVoiceTranscriptionAborted(signal);
    return text;
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError("transcription-failed", m(msg("Voice transcription failed.")), error);
  }
}
