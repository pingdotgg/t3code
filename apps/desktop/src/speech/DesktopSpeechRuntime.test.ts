import { describe, expect, it, vi } from "vite-plus/test";

import { DesktopSpeechRuntime } from "./DesktopSpeechRuntime.ts";

function makeRuntime(input: { modelReady?: boolean; pcm?: Float32Array } = {}) {
  let modelReady = input.modelReady ?? false;
  const events: unknown[] = [];
  const capture = {
    start: vi.fn(),
    stop: vi.fn(async () => input.pcm ?? new Float32Array([0.25, -0.25])),
    cancel: vi.fn(async () => undefined),
  };
  const backend = {
    prepare: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => "hello from desktop"),
    dispose: vi.fn(async () => undefined),
  };
  const downloadModel = vi.fn(
    async (_signal: AbortSignal, onProgress: (downloaded: number, total: number) => void) => {
      onProgress(5, 10);
      modelReady = true;
      return "/models/moonshine.gguf";
    },
  );
  let nextRecordingId = 0;
  const runtime = new DesktopSpeechRuntime({
    supported: true,
    modelPath: "/models/moonshine.gguf",
    modelReady: async () => modelReady,
    downloadModel,
    removeModel: vi.fn(async () => {
      modelReady = false;
    }),
    createCapture: async () => capture,
    createBackend: () => backend,
    createRecordingUri: () => `desktop-speech://recording-${++nextRecordingId}`,
    emit: (event) => events.push(event),
  });
  return { runtime, capture, backend, downloadModel, events };
}

describe("DesktopSpeechRuntime", () => {
  it("prepares the local model and reports download progress", async () => {
    const { runtime, backend, downloadModel, events } = makeRuntime();

    await expect(runtime.prepare()).resolves.toEqual({ locale: "en" });

    expect(downloadModel).toHaveBeenCalledOnce();
    expect(backend.prepare).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: "download-progress", downloaded: 5, total: 10 });
    await expect(runtime.getStatus()).resolves.toEqual({ supported: true, state: "ready" });
  });

  it("keeps captured PCM behind an opaque URI until the caller deletes it", async () => {
    const { runtime, capture, backend } = makeRuntime({ modelReady: true });
    await runtime.prepare();
    await runtime.startRecording();

    const uri = await runtime.stopRecording();
    await expect(runtime.transcribe(uri)).resolves.toBe("hello from desktop");
    expect(capture.start).toHaveBeenCalledOnce();
    expect(backend.transcribe).toHaveBeenCalledWith(new Float32Array([0.25, -0.25]));

    runtime.deleteRecording(uri);
    await expect(runtime.transcribe(uri)).rejects.toThrow("recording is unavailable");
  });

  it("returns an empty transcript for silent input", async () => {
    const { runtime, backend } = makeRuntime({
      modelReady: true,
      pcm: new Float32Array(16_000),
    });
    await runtime.prepare();
    await runtime.startRecording();

    await expect(runtime.transcribe(await runtime.stopRecording())).resolves.toBe("");
    expect(backend.transcribe).not.toHaveBeenCalled();
  });

  it("cancels capture without creating a recording", async () => {
    const { runtime, capture } = makeRuntime({ modelReady: true });
    await runtime.prepare();
    await runtime.startRecording();
    await runtime.cancelRecording();

    expect(capture.cancel).toHaveBeenCalledOnce();
    await expect(runtime.getStatus()).resolves.toEqual({ supported: true, state: "ready" });
  });
});
