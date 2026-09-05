import type { TranscriptionResult } from "@react-native-ai/apple/src/NativeAppleTranscription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";

const mocks = vi.hoisted(() => ({
  streamingAvailable: true,
  isAvailable: vi.fn<(locale: string) => boolean>(),
  prepare: vi.fn<(locale: string) => Promise<string>>(),
  prepareStreaming: vi.fn<(locale: string) => Promise<string>>(),
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
  mocks.streamingAvailable = true;
  mocks.isAvailable.mockReturnValue(true);
  mocks.prepare.mockResolvedValue("sv-SE");
  mocks.prepareStreaming.mockResolvedValue("sv-SE");
  mocks.readAudio.mockResolvedValue(audio);
  mocks.transcribe.mockResolvedValue(nativeTranscript);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLocalVoiceTranscriber", () => {
  it("keeps the selected language and Apple's resolved locale when the device language changes", async () => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
    const deviceLocale = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolvedOptions, locale: "sv-FI" });
    const transcriber = getLocalVoiceTranscriber()!;
    const options = { signal: new AbortController().signal };

    deviceLocale.mockReturnValue({ ...resolvedOptions, locale: "de-DE" });
    const prepared = await transcriber.prepare(options);
    deviceLocale.mockReturnValue({ ...resolvedOptions, locale: "en-US" });

    await expect(prepared.transcribe("file:///voice.m4a", options)).resolves.toBe("Hej världen.");
    expect(mocks.prepareStreaming).toHaveBeenCalledWith("sv-FI");
    expect(prepared.locale).toBe("sv-SE");
    expect(mocks.transcribe).toHaveBeenCalledWith(audio, "sv-SE");
  });

  it("uses file transcription when live capture is unavailable", async () => {
    mocks.streamingAvailable = false;
    const options = { signal: new AbortController().signal };

    const prepared = await getLocalVoiceTranscriber()!.prepare(options);

    expect(mocks.prepare).toHaveBeenCalledWith(expect.any(String));
    expect(mocks.prepareStreaming).not.toHaveBeenCalled();
    expect(prepared.startStreaming).toBeUndefined();
    await expect(prepared.transcribe("file:///voice.m4a", options)).resolves.toBe("Hej världen.");
  });

  it("uses file transcription when live preparation fails", async () => {
    mocks.prepareStreaming.mockRejectedValueOnce(new Error("live unavailable"));
    const options = { signal: new AbortController().signal };

    const prepared = await getLocalVoiceTranscriber()!.prepare(options);

    expect(mocks.prepare).toHaveBeenCalledWith(expect.any(String));
    expect(prepared.startStreaming).toBeUndefined();
  });

  it("does not advertise transcription when neither capture path is available", () => {
    mocks.streamingAvailable = false;
    mocks.isAvailable.mockReturnValue(false);

    expect(getLocalVoiceTranscriber()).toBeNull();
  });

  it("does not start native transcription after cancellation during a file read", async () => {
    const enteredRead = deferred<void>();
    const readResult = deferred<ArrayBuffer>();
    mocks.readAudio.mockImplementation(() => {
      enteredRead.resolve();
      return readResult.promise;
    });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const prepared = await getLocalVoiceTranscriber()!.prepare(options);
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

  it.each(["live prepare", "file prepare", "transcribe"] as const)(
    "waits for native %s to finish before settling cancellation",
    async (phase) => {
      const enteredNative = deferred<void>();
      const finishNative = deferred<void>();
      if (phase === "live prepare") {
        mocks.prepareStreaming.mockImplementation(async () => {
          enteredNative.resolve();
          await finishNative.promise;
          return "sv-SE";
        });
      } else if (phase === "file prepare") {
        mocks.streamingAvailable = false;
        mocks.prepare.mockImplementation(async () => {
          enteredNative.resolve();
          await finishNative.promise;
          return "sv-SE";
        });
      } else {
        mocks.transcribe.mockImplementation(async () => {
          enteredNative.resolve();
          await finishNative.promise;
          return nativeTranscript;
        });
      }
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const transcriber = getLocalVoiceTranscriber()!;
      const operation = phase.endsWith("prepare")
        ? transcriber.prepare(options)
        : (await transcriber.prepare(options)).transcribe("file:///voice.m4a", options);
      const settled = vi.fn((value: unknown) => value);
      const result = operation.then(settled, settled);

      await enteredNative.promise;
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).not.toHaveBeenCalled();
      finishNative.resolve();

      const error = await result;
      expect(error).toBeInstanceOf(VoiceTranscriptionError);
      expect(error).toMatchObject({ code: "cancelled" });
    },
  );
});
