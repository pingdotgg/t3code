import { requireOptionalNativeModule } from "expo";
import * as Schema from "effect/Schema";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type LiveVoiceOptions,
  type LiveVoiceSession,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);

type VoiceEvent = {
  readonly sessionId: string;
  readonly transcript?: string;
  readonly error?: string;
  readonly ended?: boolean;
  readonly durationMillis?: number;
  readonly metering?: number;
};

type NativeVoiceStreaming = {
  isAvailable(): boolean;
  prepare(locale: string): Promise<string | null>;
  start(sessionId: string, locale: string, limitSeconds: number): Promise<void>;
  stop(sessionId: string): Promise<string>;
  cancel(sessionId: string): Promise<void>;
  addListener(event: "onVoiceInput", listener: (event: VoiceEvent) => void): { remove(): void };
};

const nativeErrorMessages: Readonly<Record<string, string>> = {
  ERR_VOICE_UNAVAILABLE: "Live voice transcription is unavailable.",
  ERR_VOICE_BUSY: "Another live voice transcription is already active.",
  ERR_VOICE_AUDIO_FORMAT: "Live voice transcription could not configure audio capture.",
};

/** Maps the native module's exception codes to stable transcription errors. */
export function mapNativeVoiceError(error: unknown, phase: "preparation" | "transcription") {
  if (isVoiceTranscriptionError(error)) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const message = typeof code === "string" ? nativeErrorMessages[code] : undefined;
  if (!message) return error;
  return new VoiceTranscriptionError({
    code:
      code === "ERR_VOICE_UNAVAILABLE"
        ? "unavailable"
        : phase === "preparation"
          ? "preparation-failed"
          : "transcription-failed",
    message,
    cause: error,
  });
}

const native = requireOptionalNativeModule<NativeVoiceStreaming>("T3VoiceInput");
let sessionSequence = 0;

/** False on builds without the native module, which use file transcription instead. */
export function isVoiceStreamingAvailable(): boolean {
  return native?.isAvailable() === true;
}

/** Resolves the language and downloads both recognizers' assets before capture starts. */
export async function prepareVoiceStreaming(
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  if (!native) {
    throw new VoiceTranscriptionError({
      code: "unavailable",
      message: "Live voice transcription is unavailable.",
    });
  }
  const cancelled = Promise.withResolvers<null>();
  const cancel = () => cancelled.resolve(null);
  signal.addEventListener("abort", cancel, { once: true });
  let supportedLocale: string | null;
  try {
    supportedLocale = await Promise.race([native.prepare(locale), cancelled.promise]);
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw mapNativeVoiceError(error, "preparation");
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  throwIfVoiceTranscriptionAborted(signal);
  if (!supportedLocale) {
    throw new VoiceTranscriptionError({
      code: "unsupported-locale",
      message: "Voice transcription does not support any of your languages.",
    });
  }
  return supportedLocale;
}

export async function startVoiceStreaming(
  locale: string,
  limitSeconds: number,
  options: LiveVoiceOptions,
): Promise<LiveVoiceSession> {
  throwIfVoiceTranscriptionAborted(options.signal);
  if (!native) {
    throw new VoiceTranscriptionError({
      code: "unavailable",
      message: "Live voice transcription is unavailable.",
    });
  }
  const module = native;
  const sessionId = `voice-${++sessionSequence}`;
  let status: ReturnType<LiveVoiceSession["getStatus"]> = null;
  let cancellation: Promise<void> | null = null;
  let startupError: string | null = null;
  let started = false;
  let closed = false;
  const subscription = module.addListener("onVoiceInput", (event) => {
    if (closed || options.signal.aborted || event.sessionId !== sessionId) return;
    if (event.transcript !== undefined) options.onTranscript(event.transcript);
    if (event.durationMillis !== undefined) {
      status = { durationMillis: event.durationMillis, metering: event.metering };
    }
    if (event.error !== undefined) {
      if (started) options.onError(event.error);
      else startupError ??= event.error;
    }
    if (event.ended) options.onEnd();
  });
  const close = () => {
    if (closed) return;
    closed = true;
    status = null;
    subscription.remove();
    options.signal.removeEventListener("abort", onAbort);
  };
  const cancel = () => {
    close();
    cancellation ??= module.cancel(sessionId);
    return cancellation;
  };
  const onAbort = () => {
    void cancel().catch(() => undefined);
  };

  // Cancelling during startup settles only after the engine has finished starting.
  try {
    await module.start(sessionId, locale, limitSeconds);
    throwIfVoiceTranscriptionAborted(options.signal);
    if (startupError !== null)
      throw new VoiceTranscriptionError({ code: "transcription-failed", message: startupError });
    started = true;
    options.signal.addEventListener("abort", onAbort, { once: true });
  } catch (error) {
    await cancel().catch(() => undefined);
    throw mapNativeVoiceError(error, "transcription");
  }

  let stopped = false;
  return {
    getStatus: () => status,
    cancel: () => (stopped ? Promise.resolve() : cancel()),
    stop: async () => {
      try {
        const transcript = await module.stop(sessionId);
        throwIfVoiceTranscriptionAborted(options.signal);
        return transcript;
      } catch (error) {
        throw mapNativeVoiceError(error, "transcription");
      } finally {
        stopped = true;
        close();
      }
    },
  };
}
