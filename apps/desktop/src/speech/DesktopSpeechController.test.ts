// @effect-diagnostics globalTimers:off - this test exercises the controller's native timer boundary.
import { describe, expect, it, vi } from "vite-plus/test";

import { DesktopSpeechController } from "./DesktopSpeechController.ts";

function makeController(maxRecordingMs?: number) {
  const events: unknown[] = [];
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
  const controller = new DesktopSpeechController({
    supported: true,
    modelReady: vi.fn().mockResolvedValue(false),
    downloadModel: vi.fn().mockImplementation(async (onProgress) => {
      onProgress(5, 10);
      return "/tmp/model.gguf";
    }),
    removeModel: vi.fn().mockResolvedValue(undefined),
    createCapture: () => capture,
    createBackend: () => backend,
    emit: (event) => events.push(event),
    ...(maxRecordingMs === undefined ? {} : { maxRecordingMs }),
  });
  return { controller, capture, backend, events };
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
});
