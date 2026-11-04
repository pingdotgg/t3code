import type { TranscriptionResult } from "@react-native-ai/apple/src/NativeAppleTranscription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";

const mocks = vi.hoisted(() => ({
  streamingAvailable: false,
  prepareStreaming: vi.fn<(locale: string) => Promise<string>>(),
  isAvailable: vi.fn<(locale: string) => boolean>(),
  prepare: vi.fn<(locale: string) => Promise<string>>(),
  transcribe: vi.fn<(audio: ArrayBufferLike, locale: string) => Promise<TranscriptionResult>>(),
  readAudio: vi.fn<() => Promise<ArrayBuffer>>(),
}));

vi.mock("@react-native-ai/apple/src/NativeAppleTranscription", () => ({
  default: {
    isAvailable: mocks.isAvailable,
    prepare: mocks.prepare,
    transcribe: mocks.transcribe,
  },
}));

vi.mock("./voiceStreaming.ios", () => ({
  isVoiceStreamingAvailable: () => mocks.streamingAvailable,
  prepareVoiceStreaming: (locale: string) => mocks.prepareStreaming(locale),
  startVoiceStreaming: vi.fn(),
  mapNativeVoiceError: (error: unknown) => error,
}));

vi.mock("expo-file-system", () => ({
  File: class {
    arrayBuffer = mocks.readAudio;
  },
}));

import { getLocalVoiceTranscriber } from "./voiceTranscription.ios";

const audio = new ArrayBuffer(4);
const nativeTranscript: TranscriptionResult = {
  duration: 2,
  segments: [
    { text: " Hej", startSecond: 0, endSecond: 1 },
    { text: "världen. ", startSecond: 1, endSecond: 2 },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.streamingAvailable = false;
  mocks.prepareStreaming.mockResolvedValue("sv-SE");
  mocks.isAvailable.mockReturnValue(true);
  mocks.prepare.mockResolvedValue("sv-SE");
  mocks.readAudio.mockResolvedValue(audio);
  mocks.transcribe.mockResolvedValue(nativeTranscript);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLocalVoiceTranscriber", () => {
  it("does not start native transcription after cancellation during a file read", async () => {
    const enteredRead = deferred<void>();
    const readResult = deferred<ArrayBuffer>();
    mocks.readAudio.mockImplementation(() => {
      enteredRead.resolve();
      return readResult.promise;
    });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const prepared = await (await getLocalVoiceTranscriber())!.prepare(options);
    const result = prepared
      .transcribe("file:///voice.m4a", options)
      .catch((error: unknown) => error);

    await enteredRead.promise;
    controller.abort();
    readResult.resolve(audio);

    const error = await result;
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it("prefers live capture and keeps file transcription as its fallback", async () => {
    mocks.streamingAvailable = true;
    const options = { signal: new AbortController().signal };

    const prepared = await (await getLocalVoiceTranscriber())!.prepare(options);

    expect(mocks.prepareStreaming).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(prepared.locale).toBe("sv-SE");
    expect(prepared.startStreaming).toBeTypeOf("function");
    const fallback = await prepared.prepareFileFallback!(options);
    expect(fallback.startStreaming).toBeUndefined();
    await expect(fallback.transcribe("file:///voice.m4a", options)).resolves.toBe("Hej världen.");
  });

  it("uses file transcription when live preparation fails", async () => {
    mocks.streamingAvailable = true;
    mocks.prepareStreaming.mockRejectedValueOnce(new Error("assets unavailable"));
    const options = { signal: new AbortController().signal };

    const prepared = await (await getLocalVoiceTranscriber())!.prepare(options);

    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(prepared.startStreaming).toBeUndefined();
  });

  it("reports the live failure when there is no file fallback", async () => {
    mocks.streamingAvailable = true;
    mocks.isAvailable.mockReturnValue(false);
    mocks.prepareStreaming.mockRejectedValueOnce(
      new VoiceTranscriptionError("unavailable", "Live voice transcription is unavailable."),
    );

    const error = await (await getLocalVoiceTranscriber())!
      .prepare({ signal: new AbortController().signal })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "unavailable" });
  });

  it("is unavailable when neither capture path is", async () => {
    mocks.isAvailable.mockReturnValue(false);

    await expect(getLocalVoiceTranscriber()).resolves.toBeNull();
  });
});
