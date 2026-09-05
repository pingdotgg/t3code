import { requireOptionalNativeModule } from "expo";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type VoiceTranscriptionOptions,
  type VoiceStreamingOptions,
  type VoiceStreamingSession,
} from "@t3tools/client-runtime/voice-input";

type VoiceEvent = {
  sessionId: string;
  transcript?: string;
  error?: string;
  ended?: boolean;
  durationMillis?: number;
  metering?: number;
};

type NativeVoiceStreaming = {
  isAvailable?: () => boolean;
  prepare?: (locale: string) => Promise<string | null>;
  start: (sessionId: string, locale: string, limitSeconds: number) => Promise<void>;
  stop: (sessionId: string) => Promise<string>;
  cancel: (sessionId: string) => Promise<void>;
  addListener: (event: "onVoiceInput", listener: (event: VoiceEvent) => void) => { remove(): void };
};

const native = requireOptionalNativeModule<NativeVoiceStreaming>("T3VoiceInput");
let sessionSequence = 0;

export function isVoiceStreamingAvailable(): boolean {
  return native?.isAvailable?.() === true;
}

export async function prepareVoiceStreaming(
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  if (!native?.prepare) throw new Error("Live dictation requires an updated app build.");
  const supportedLocale = await native.prepare(locale);
  throwIfVoiceTranscriptionAborted(signal);
  if (!supportedLocale) {
    throw new VoiceTranscriptionError(
      "unsupported-locale",
      "Dictation does not support this device language.",
    );
  }
  return supportedLocale;
}

export async function startVoiceStreaming(
  locale: string,
  limitSeconds: number,
  options: VoiceStreamingOptions,
): Promise<VoiceStreamingSession> {
  throwIfVoiceTranscriptionAborted(options.signal);
  if (!native) throw new Error("Live dictation requires an updated app build.");
  const module = native;
  const sessionId = `voice-${++sessionSequence}`;
  let status: ReturnType<VoiceStreamingSession["getStatus"]> = null;
  let cancelPromise: Promise<void> | null = null;
  let closed = false;
  const subscription = module.addListener("onVoiceInput", (event) => {
    if (closed || options.signal.aborted || event.sessionId !== sessionId) return;
    if (event.transcript !== undefined) options.onTranscript(event.transcript);
    if (event.durationMillis !== undefined) {
      status = {
        isRecording: true,
        durationMillis: event.durationMillis,
        metering: event.metering,
      };
    }
    if (event.error) options.onError(event.error);
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
    cancelPromise ??= module.cancel(sessionId);
    return cancelPromise;
  };
  const onAbort = () => {
    void cancel().catch(() => undefined);
  };
  // Cancellation during startup settles only after the engine has finished starting.
  try {
    await module.start(sessionId, locale, limitSeconds);
    throwIfVoiceTranscriptionAborted(options.signal);
    options.signal.addEventListener("abort", onAbort, { once: true });
    return {
      getStatus: () => status,
      cancel,
      stop: async () => {
        try {
          const text = await module.stop(sessionId);
          throwIfVoiceTranscriptionAborted(options.signal);
          return text;
        } finally {
          close();
        }
      },
    };
  } catch (error) {
    await cancel().catch(() => undefined);
    throw error;
  }
}
