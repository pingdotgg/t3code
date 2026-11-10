import { expect, it, vi } from "vite-plus/test";
import { createBrowserPcmCapture } from "./browserPcmCapture";
import { stubGlobal } from "../../test/render";

it("cancels an unanswered permission prompt and stops a late microphone stream", async () => {
  let grantPermission!: (media: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    grantPermission = resolve;
  });
  using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(permission);
  const capture = createBrowserPcmCapture(
    { getMicrophoneId: () => "", onLevel: vi.fn(), onDurationLimit: vi.fn(), onError: vi.fn() },
    async () => ({ locale: "en", transcribe: async () => "" }),
  );
  const abort = new AbortController();
  await capture.transcriber.prepare({ signal: abort.signal });
  const rejected = vi.fn();
  const preparing = capture.recorder.prepareToRecordAsync(abort.signal).catch(rejected);
  expect(microphone).toHaveBeenCalledOnce();
  abort.abort();
  const stop = vi.fn();
  try {
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(abort.signal.reason));
  } finally {
    grantPermission({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await preparing;
  }
  expect(stop).toHaveBeenCalledOnce();
});

it("keeps a released recording when the next capture starts", async () => {
  class FakeWorkletNode {
    onprocessorerror: (() => void) | null = null;
    readonly port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: string) => {
        const reply = message === "start" ? new Float32Array([0.5]) : "stopped";
        queueMicrotask(() => this.port.onmessage?.({ data: reply }));
      },
      close() {},
    };
    connect() {}
    disconnect() {}
  }
  class FakeAudioContext {
    readonly destination = {};
    readonly audioWorklet = { addModule: async () => {} };
    createMediaStreamSource = () => ({ connect() {} });
    resume = async () => {};
    close = async () => {};
  }
  using _context = stubGlobal("AudioContext", FakeAudioContext);
  using _worklet = stubGlobal("AudioWorkletNode", FakeWorkletNode);
  using _microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockResolvedValue({ getTracks: () => [] } as unknown as MediaStream);
  const capture = createBrowserPcmCapture(
    { getMicrophoneId: () => "", onLevel: vi.fn(), onDurationLimit: vi.fn(), onError: vi.fn() },
    async () => ({ locale: "en", transcribe: async () => "" }),
  );
  const signal = new AbortController().signal;
  const record = async () => {
    await capture.transcriber.prepare({ signal });
    await capture.recorder.prepareToRecordAsync(signal);
    capture.recorder.record({ forDuration: 60 });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await capture.recorder.stop();
    return capture.recorder.uri!;
  };

  const parked = await record();
  capture.releaseRecording(parked);
  const next = await record();
  expect(next).not.toBe(parked);
  await expect(fetch(parked).then((response) => response.arrayBuffer())).resolves.toHaveProperty(
    "byteLength",
    4,
  );
  capture.deleteRecording(parked);
  await expect(fetch(parked)).rejects.toThrow();
});
