import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

const mocks = vi.hoisted(() => ({
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
    Effect.succeed({ supported: true, state: "ready", supportsStreaming: true }),
  getEnvironmentSpeechStreamUrl: () => Effect.succeed("ws://speech.test"),
  openSpeechStream: () => mocks.stream.promise,
}));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: Effect.runPromise } }));

import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";

let worklet: {
  port: {
    onmessage: ((event: { data: Float32Array }) => void) | null;
    postMessage: () => void;
    close: () => void;
  };
};

afterEach(() => vi.unstubAllGlobals());

it("starts microphone capture while a streaming model is loading and preserves early audio", async () => {
  const feed = vi.fn();
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
    getMicrophoneId: () => "",
    onLevel() {},
    onDurationLimit() {},
    onText() {},
    onError: vi.fn(),
  });
  const transcription = await platform.transcriber.prepare({
    signal: new AbortController().signal,
  });
  await platform.recorder.prepareToRecordAsync();
  platform.recorder.record({ forDuration: 300 });
  const earlyAudio = new Float32Array([0.25, 0.5]);
  worklet.port.onmessage?.({ data: earlyAudio });

  expect(feed).not.toHaveBeenCalled();
  mocks.stream.resolve({ feed, finish: async () => "hello" });
  await expect(
    transcription.streaming?.finish({ signal: new AbortController().signal }),
  ).resolves.toBe("hello");
  expect(feed).toHaveBeenCalledWith(earlyAudio);
  platform.cancelRecording();
});
