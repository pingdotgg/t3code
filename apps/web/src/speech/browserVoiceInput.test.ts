import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

const mocks = vi.hoisted(() => ({
  supportsStreaming: true,
  supportsTranslation: true,
  stream: (() => {
    type Stream = {
      feed: (pcm: Float32Array) => void;
      finish: () => Promise<string>;
    };
    let resolve!: (stream: Stream) => void;
    const promise = new Promise<Stream>((accept) => {
      resolve = accept;
    });
    return { promise, resolve };
  })(),
}));

vi.mock("@t3tools/client-runtime/voice-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/voice-input")>()),
  getEnvironmentSpeechStatus: () =>
    Effect.succeed({
      supported: true,
      state: "ready",
      supportsStreaming: mocks.supportsStreaming,
      supportsTranslation: mocks.supportsTranslation,
    }),
  prepareEnvironmentSpeechModel: () => Effect.succeed({ supported: true, state: "ready" }),
  getEnvironmentSpeechStreamUrl: () => Effect.succeed("ws://speech.test"),
  openSpeechStream: () => mocks.stream.promise,
}));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: Effect.runPromise } }));

import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";

let worklet: {
  port: {
    onmessage: ((event: { data: Float32Array | number | "stopped" }) => void) | null;
    postMessage: () => void;
    close: () => void;
  };
};

afterEach(() => {
  mocks.supportsStreaming = true;
  mocks.supportsTranslation = true;
  vi.unstubAllGlobals();
});

it("preserves audio when recording stops before the streaming model is ready", async () => {
  const feed = vi.fn();
  const onLevel = vi.fn();
  worklet = {
    port: { onmessage: null, postMessage: vi.fn(), close: vi.fn() },
  };
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      audioWorklet = { addModule: async () => {} };
      destination = {};
      createMediaStreamSource() {
        return { connect: () => {} };
      }
      resume = async () => {};
      close = async () => {};
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = worklet.port;
      connect() {}
      disconnect() {}
    },
  );

  const platform = createBrowserVoiceInputPlatform({
    prepared: {} as PreparedConnection,
    getTranscriptionOptions: () => DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
    getMicrophoneId: () => "",
    onLevel,
    onDurationLimit() {},
    onText() {},
    onError: vi.fn(),
  });
  const transcription = await platform.transcriber.prepare({
    signal: new AbortController().signal,
  });
  await platform.recorder.prepareToRecordAsync();
  platform.recorder.record({ forDuration: 300 });
  worklet.port.onmessage?.({ data: 0.4 });
  expect(onLevel).toHaveBeenLastCalledWith(0.4);
  const earlyAudio = new Float32Array([0.25, 0.5]);
  worklet.port.onmessage?.({ data: earlyAudio });

  expect(feed).not.toHaveBeenCalled();
  const stopping = platform.recorder.stop();
  worklet.port.onmessage?.({ data: "stopped" });
  await stopping;
  mocks.stream.resolve({ feed, finish: async () => "hello" });
  await expect(
    transcription.streaming?.finish({ signal: new AbortController().signal }),
  ).resolves.toBe("hello");
  expect(feed).toHaveBeenCalledWith(earlyAudio);
  platform.cancelRecording();
});

it.each([
  [true, "fr", false, "fr"],
  [false, "fr", false, "fr"],
  [true, "ja", false, "ja"],
  [false, "ja", false, "ja"],
  [true, "ja", true, "ja"],
  [false, "ja", true, "en"],
  [true, "auto", false, "auto"],
  [false, "auto", false, "auto"],
] as const)(
  "carries output locale for streaming=%s, language=%s, translate=%s",
  async (supportsStreaming, speechLanguage, speechTranslateToEnglish, locale) => {
    mocks.supportsStreaming = supportsStreaming;
    const platform = createBrowserVoiceInputPlatform({
      prepared: {} as PreparedConnection,
      getTranscriptionOptions: () => ({
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage,
        speechTranslateToEnglish,
      }),
      getMicrophoneId: () => "",
      onLevel() {},
      onDurationLimit() {},
      onText() {},
      onError: vi.fn(),
    });
    const transcription = await platform.transcriber.prepare({
      signal: new AbortController().signal,
    });
    expect(transcription.locale).toBe(locale);
    expect(Boolean(transcription.streaming)).toBe(supportsStreaming);
  },
);

it("keeps the selected output language when the model cannot translate", async () => {
  mocks.supportsStreaming = false;
  mocks.supportsTranslation = false;
  const platform = createBrowserVoiceInputPlatform({
    prepared: {} as PreparedConnection,
    getTranscriptionOptions: () => ({
      ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
      speechLanguage: "ja",
      speechTranslateToEnglish: true,
    }),
    getMicrophoneId: () => "",
    onLevel() {},
    onDurationLimit() {},
    onText() {},
    onError: vi.fn(),
  });
  const transcription = await platform.transcriber.prepare({
    signal: new AbortController().signal,
  });
  expect(transcription.locale).toBe("ja");
});
