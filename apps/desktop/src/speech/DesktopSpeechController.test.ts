// @effect-diagnostics globalTimers:off - this test exercises the controller's native timer boundary.
import { describe, expect, it, vi } from "vite-plus/test";

import { DesktopSpeechController } from "./DesktopSpeechController.ts";

function makeController(maxRecordingMs?: number) {
  const events: unknown[] = [];
  let modelReady = false;
  const capture = {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(new Float32Array([0.25, -0.25])),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const backend = {
    prepare: vi.fn().mockResolvedValue(undefined),
    transcribe: vi.fn().mockResolvedValue("hello from speech"),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const downloadModel = vi.fn().mockImplementation(async (onProgress) => {
    onProgress(5, 10);
    modelReady = true;
    return "/tmp/model.gguf";
  });
  const controller = new DesktopSpeechController({
    supported: true,
    modelPath: "/tmp/model.gguf",
    modelReady: vi.fn().mockImplementation(async () => modelReady),
    downloadModel,
    removeModel: vi.fn().mockResolvedValue(undefined),
    createCapture: () => capture,
    createBackend: () => backend,
    emit: (event) => events.push(event),
    ...(maxRecordingMs === undefined ? {} : { maxRecordingMs }),
  });
  return { controller, capture, backend, downloadModel, events };
}

describe("DesktopSpeechController", () => {
  it("downloads, records, transcribes, and emits the final transcript", async () => {
    const { controller, capture, backend, events } = makeController();

    expect(await controller.start()).toMatchObject({ supported: true, state: "recording" });
    expect(await controller.stop()).toMatchObject({ supported: true, state: "ready" });

    expect(capture.start).toHaveBeenCalledOnce();
    expect(backend.prepare).toHaveBeenCalledOnce();
    expect(backend.transcribe).toHaveBeenCalledWith(new Float32Array([0.25, -0.25]));
    expect(events).toContainEqual({ type: "download-progress", downloaded: 5, total: 10 });
    expect(events).toContainEqual({ type: "transcript", text: "hello from speech" });
  });

  it("cancels recording without transcribing", async () => {
    const { controller, capture, backend, events } = makeController();

    await controller.start();
    expect(await controller.cancel()).toMatchObject({ supported: true, state: "ready" });

    expect(capture.cancel).toHaveBeenCalledOnce();
    expect(backend.transcribe).not.toHaveBeenCalled();
    expect(events.some((event) => (event as { type?: string }).type === "transcript")).toBe(false);
  });

  it("automatically stops a recording at the duration limit", async () => {
    const { controller, backend } = makeController(1);
    await controller.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(backend.transcribe).toHaveBeenCalledOnce();
  });

  it("suppresses a transcript when cancellation arrives during stop", async () => {
    const { controller, backend, events } = makeController();
    let resolveTranscription!: (text: string) => void;
    backend.transcribe.mockImplementation(
      () => new Promise<string>((resolve) => (resolveTranscription = resolve)),
    );
    await controller.start();

    const stopping = controller.stop();
    await vi.waitFor(() => expect(backend.transcribe).toHaveBeenCalledOnce());
    const cancelling = controller.cancel();
    resolveTranscription("discard this text");
    await Promise.all([stopping, cancelling]);

    expect(events).not.toContainEqual({ type: "transcript", text: "discard this text" });
  });

  it("does not open the microphone when cancelled during model download", async () => {
    const { controller, capture, downloadModel } = makeController();
    let finishDownload!: (path: string) => void;
    downloadModel.mockImplementation(
      () => new Promise<string>((resolve) => (finishDownload = resolve)),
    );

    const starting = controller.start();
    await vi.waitFor(() => expect(downloadModel).toHaveBeenCalledOnce());
    const cancelling = controller.cancel();
    finishDownload("/tmp/model.gguf");
    await Promise.all([starting, cancelling]);

    expect(capture.start).not.toHaveBeenCalled();
  });
});
