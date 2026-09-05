import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { VoiceStreamingOptions } from "@t3tools/client-runtime/voice-input";

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
import {
  startVoiceStreaming,
  prepareVoiceStreaming,
  isVoiceStreamingAvailable,
} from "./voiceStreaming.ios";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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

function options(): VoiceStreamingOptions {
  return {
    signal: new AbortController().signal,
    onTranscript: vi.fn(),
    onError: vi.fn(),
    onEnd: vi.fn(),
  };
}

it("delivers interim results before stop and ignores events belonging to another session", async () => {
  const callbacks = options();
  const session = await startVoiceStreaming("en-AU", 300, callbacks);
  const id = native.start.mock.calls[0]![0];
  const emit = native.addListener.mock.calls[0]![1];
  emit({ sessionId: "old", transcript: "Old words" });
  emit({ sessionId: id, transcript: "New words" });
  expect(callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith("New words");
  expect(native.stop).not.toHaveBeenCalled();
  await expect(session.stop()).resolves.toBe("Final words.");
  emit({ sessionId: id, transcript: "Late words" });
  expect(callbacks.onTranscript).toHaveBeenCalledTimes(1);
  expect(native.remove).toHaveBeenCalled();
});

it("does not release cancellation during startup until native capture stops", async () => {
  const started = deferred<void>();
  const cancelled = deferred<void>();
  native.start.mockReturnValue(started.promise);
  native.cancel.mockReturnValue(cancelled.promise);
  const abort = new AbortController();
  const settled = vi.fn();
  const result = startVoiceStreaming("en-AU", 300, { ...options(), signal: abort.signal }).then(
    settled,
    (error: unknown) => {
      settled();
      return error;
    },
  );
  abort.abort();
  expect(native.cancel).not.toHaveBeenCalled();
  started.resolve();
  // Drain promise reactions so the native cancellation boundary is reached.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(native.cancel).toHaveBeenCalledTimes(1);
  expect(settled).not.toHaveBeenCalled();
  cancelled.resolve();
  await expect(result).resolves.toMatchObject({ code: "cancelled" });
});

it("cancels native capture once and immediately suppresses late events", async () => {
  const abort = new AbortController();
  const callbacks = { ...options(), signal: abort.signal };
  const session = await startVoiceStreaming("en-AU", 300, callbacks);
  const emit = native.addListener.mock.calls[0]![1];
  const sessionId = native.start.mock.calls[0]![0];
  abort.abort();
  emit({ sessionId, transcript: "Late" });
  await session.cancel();
  expect(native.cancel).toHaveBeenCalledTimes(1);
  expect(callbacks.onTranscript).not.toHaveBeenCalled();
});

describe("capture events", () => {
  it("reports real audio levels, recording limit, and interruptions", async () => {
    const callbacks = options();
    const session = await startVoiceStreaming("en-AU", 300, callbacks);
    const emit = native.addListener.mock.calls[0]![1];
    const sessionId = native.start.mock.calls[0]![0];
    emit({ sessionId, durationMillis: 1800, metering: -20 });
    expect(session.getStatus()).toEqual({ isRecording: true, durationMillis: 1800, metering: -20 });
    emit({ sessionId, ended: true });
    expect(callbacks.onEnd).toHaveBeenCalledOnce();
    emit({ sessionId, error: "Interrupted" });
    expect(callbacks.onError).toHaveBeenCalledWith("Interrupted");
    await session.cancel();
  });
});

it("prepares the streaming engine language and reports unsupported locales", async () => {
  expect(isVoiceStreamingAvailable()).toBe(true);
  await expect(prepareVoiceStreaming("en-AU", options())).resolves.toBe("en-AU");
  native.prepare.mockResolvedValue(null);
  await expect(prepareVoiceStreaming("unsupported", options())).rejects.toMatchObject({
    code: "unsupported-locale",
  });
});

it("rejects cancelled language preparation only after native work settles", async () => {
  const prepared = deferred<string>();
  native.prepare.mockReturnValue(prepared.promise);
  const abort = new AbortController();
  const settled = vi.fn();
  const result = prepareVoiceStreaming("en-AU", { signal: abort.signal }).then(
    settled,
    (error: unknown) => {
      settled();
      return error;
    },
  );
  abort.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).not.toHaveBeenCalled();
  prepared.resolve("en-AU");
  await expect(result).resolves.toMatchObject({ code: "cancelled" });
});
