import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  VoiceTranscriptionError,
  type LiveVoiceOptions,
} from "@t3tools/client-runtime/voice-input";

const native = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  prepare: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  addListener: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => native }));
import { prepareVoiceStreaming, startVoiceStreaming } from "./voiceStreaming.ios";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function options(signal = new AbortController().signal): LiveVoiceOptions {
  return { signal, onTranscript: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
}

/** Starts a session and returns its native event emitter. */
async function started(callbacks = options()) {
  const session = await startVoiceStreaming("en-AU", 300, callbacks);
  const sessionId = native.start.mock.calls[0]![0];
  const listener = native.addListener.mock.calls[0]![1];
  return { session, callbacks, emit: (event: object) => listener({ sessionId, ...event }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  native.isAvailable.mockReturnValue(true);
  native.prepare.mockResolvedValue("en-AU");
  native.start.mockResolvedValue(undefined);
  native.stop.mockResolvedValue("Final words.");
  native.cancel.mockResolvedValue(undefined);
  native.addListener.mockReturnValue({ remove: native.remove });
});

it("streams this session's words, levels, limit and interruptions until stop", async () => {
  const { session, callbacks, emit } = await started();
  native.addListener.mock.calls[0]![1]({ sessionId: "old", transcript: "Old words" });
  emit({ transcript: "New words" });
  emit({ durationMillis: 1800, metering: -20 });
  emit({ ended: true });
  emit({ error: "Interrupted" });

  expect(callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith("New words");
  expect(session.getStatus()).toEqual({ durationMillis: 1800, metering: -20 });
  expect(callbacks.onEnd).toHaveBeenCalledOnce();
  expect(callbacks.onError).toHaveBeenCalledWith("Interrupted");
  await expect(session.stop()).resolves.toBe("Final words.");
  emit({ transcript: "Late words" });
  await session.cancel();
  expect(callbacks.onTranscript).toHaveBeenCalledOnce();
  expect(native.remove).toHaveBeenCalled();
  expect(native.cancel).not.toHaveBeenCalled();
});

it("settles a cancelled startup only after native capture has stopped", async () => {
  const start = deferred<void>();
  const cancelEntered = deferred<void>();
  const cancelled = deferred<void>();
  native.start.mockReturnValue(start.promise);
  native.cancel.mockImplementation(() => {
    cancelEntered.resolve();
    return cancelled.promise;
  });
  const abort = new AbortController();
  const settled = vi.fn();
  const result = startVoiceStreaming("en-AU", 300, options(abort.signal)).catch((error) => {
    settled();
    return error;
  });

  abort.abort();
  expect(native.cancel).not.toHaveBeenCalled();
  start.resolve();
  await cancelEntered.promise;
  expect(settled).not.toHaveBeenCalled();
  cancelled.resolve();
  await expect(result).resolves.toMatchObject({ code: "cancelled" });
});

it("turns an error during startup into a rejection after native cleanup", async () => {
  const start = deferred<void>();
  native.start.mockReturnValue(start.promise);
  const callbacks = options();
  const result = startVoiceStreaming("en-AU", 300, callbacks).catch((error: unknown) => error);
  native.addListener.mock.calls[0]![1]({
    sessionId: native.start.mock.calls[0]![0],
    error: "Live dictation was interrupted.",
  });
  start.resolve();

  await expect(result).resolves.toMatchObject({
    code: "transcription-failed",
    message: "Live dictation was interrupted.",
  });
  expect(callbacks.onError).not.toHaveBeenCalled();
  expect(native.cancel).toHaveBeenCalledOnce();
});

it.each([
  ["ERR_VOICE_UNAVAILABLE", "unavailable", "unavailable"],
  ["ERR_VOICE_BUSY", "transcription-failed", "already active"],
  ["ERR_VOICE_AUDIO_FORMAT", "transcription-failed", "configure audio capture"],
] as const)("cancels capture and maps native startup error %s", async (nativeCode, code, text) => {
  native.start.mockRejectedValueOnce({ code: nativeCode });

  const error = await startVoiceStreaming("en-AU", 300, options()).catch((cause: unknown) => cause);

  expect(error).toBeInstanceOf(VoiceTranscriptionError);
  expect(error).toMatchObject({ code, message: expect.stringContaining(text) });
  expect(native.cancel).toHaveBeenCalledOnce();
  expect(native.remove).toHaveBeenCalledOnce();
});

it("cancels native capture once on abort and drops late events", async () => {
  const abort = new AbortController();
  const { session, callbacks, emit } = await started(options(abort.signal));
  abort.abort();
  emit({ transcript: "Late" });
  await session.cancel();
  expect(native.cancel).toHaveBeenCalledOnce();
  expect(callbacks.onTranscript).not.toHaveBeenCalled();
});

it("prepares the language and reports unsupported or unavailable engines", async () => {
  await expect(prepareVoiceStreaming("en-AU", options())).resolves.toBe("en-AU");
  native.prepare.mockResolvedValueOnce(null);
  await expect(prepareVoiceStreaming("xx", options())).rejects.toMatchObject({
    code: "unsupported-locale",
  });
  native.prepare.mockRejectedValueOnce({ code: "ERR_VOICE_UNAVAILABLE" });
  await expect(prepareVoiceStreaming("en-AU", options())).rejects.toMatchObject({
    code: "unavailable",
  });
});

it("stops waiting for a model on abort, and a late native failure does not reach the retry", async () => {
  const abandoned = deferred<string | null>();
  native.prepare.mockReturnValueOnce(abandoned.promise);
  const abort = new AbortController();
  const result = prepareVoiceStreaming("en-AU", options(abort.signal));

  abort.abort();
  await expect(result).rejects.toMatchObject({ code: "cancelled" });

  const next = deferred<string | null>();
  native.prepare.mockReturnValueOnce(next.promise);
  const retry = prepareVoiceStreaming("en-AU", options());
  abandoned.reject({ code: "ERR_VOICE_UNAVAILABLE" });
  next.resolve("en-AU");
  await expect(retry).resolves.toBe("en-AU");
});
