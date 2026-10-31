import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { VoiceInputController } from "@t3tools/client-runtime/voice-input";

const mocks = vi.hoisted(() => ({
  openStream: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/voice-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/voice-input")>()),
  getEnvironmentSpeechStatus: () =>
    Effect.succeed({ supported: true, state: "ready", supportsStreaming: true }),
  getEnvironmentSpeechStreamUrl: () => Effect.succeed("ws://speech.test"),
  openSpeechStream: mocks.openStream,
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

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])("keeps pending streaming audio unless cancelled: %s", async (cancelled) => {
  const session = Promise.withResolvers<{
    feed: (pcm: Float32Array) => void;
    finish: () => Promise<string>;
  }>();
  mocks.openStream.mockReturnValueOnce(session.promise);
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
    getMicrophoneId: () => "",
    onLevel,
    onDurationLimit() {},
    onText() {},
    onError: vi.fn(),
  });
  const released = Promise.withResolvers<void>();
  const commitDraft = vi.fn();
  const controller = new VoiceInputController<true>({
    recorder: platform.recorder,
    getTranscriber: () => platform.transcriber,
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => undefined,
    releaseRecording: async () => {
      platform.releaseRecording();
      released.resolve();
    },
    deleteRecording: platform.deleteRecording,
    readDraft: () => ({
      ownerKey: "draft",
      text: "",
      selection: { start: 0, end: 0 },
      revision: 0,
    }),
    commitDraft,
    onStateChange() {},
  });
  await controller.start();
  worklet.port.onmessage?.({ data: 0.4 });
  expect(onLevel).toHaveBeenLastCalledWith(0.4);
  const earlyAudio = new Float32Array([0.25, 0.5]);
  worklet.port.onmessage?.({ data: earlyAudio });

  expect(feed).not.toHaveBeenCalled();
  let stopping: Promise<void> | undefined;
  if (cancelled) controller.cancel();
  else {
    stopping = controller.stop();
    worklet.port.onmessage?.({ data: "stopped" });
  }
  await released.promise;
  session.resolve({ feed, finish: async () => "hello" });
  await stopping;
  if (cancelled) {
    expect(feed).not.toHaveBeenCalled();
    expect(commitDraft).not.toHaveBeenCalled();
  } else {
    expect(feed).toHaveBeenCalledWith(earlyAudio);
    expect(commitDraft).toHaveBeenCalledWith("hello", { start: 5, end: 5 });
  }
  controller.dispose();
});
