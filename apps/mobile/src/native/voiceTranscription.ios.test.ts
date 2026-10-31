import type { TranscriptionResult } from "@react-native-ai/apple/src/NativeAppleTranscription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";

const mocks = vi.hoisted(() => ({
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
});
