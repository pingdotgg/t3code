// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DesktopVoiceRecorder } from "./desktopVoiceCapture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function microphone() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  return { track, stream };
}
it("releases a microphone granted after cancellation without starting an audio context", async () => {
  let grantPermission!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    grantPermission = resolve;
  });
  const { track, stream } = microphone();
  const getUserMedia = vi.fn(() => permission);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const recorder = new DesktopVoiceRecorder(() => "usb-mic", vi.fn());
  const preparing = recorder.prepareToRecordAsync();
  await recorder.release();
  grantPermission(stream as unknown as MediaStream);
  await expect(preparing).rejects.toThrow("Cancelled");
  expect(track.stop).toHaveBeenCalledOnce();
  expect(getUserMedia.mock.calls[0]).toEqual([
    {
      audio: { deviceId: { exact: "usb-mic" }, channelCount: 1, echoCancellation: true },
      video: false,
    },
  ]);
});
it("propagates denied permissions without retaining recording resources", async () => {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")),
    },
  });
  const recorder = new DesktopVoiceRecorder(() => "", vi.fn());
  await expect(recorder.prepareToRecordAsync()).rejects.toMatchObject({ name: "NotAllowedError" });
  await recorder.release();
  recorder.clear();
  expect(recorder.uri).toBeNull();
});
it("reports removal and closes microphone tracks, worklet messages and audio resources", async () => {
  const { track, stream } = microphone();
  const close = vi.fn(async () => {});
  const port = Object.assign(new EventTarget(), {
    start: vi.fn(),
    close: vi.fn(),
    postMessage: vi.fn(),
  });
  port.postMessage.mockImplementation(() =>
    port.dispatchEvent(new MessageEvent("message", { data: "stopped" })),
  );
  const disconnect = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:audio"), revokeObjectURL: vi.fn() });
  vi.stubGlobal(
    "AudioContext",
    class {
      sampleRate = 16000;
      state = "running";
      audioWorklet = { addModule: async () => {} };
      destination = {};
      close = close;
      resume = async () => {};
      createMediaStreamSource() {
        return { connect: vi.fn() };
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn() };
      }
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class extends EventTarget {
      port = port;
      connect = vi.fn();
      disconnect = disconnect;
    },
  );
  const ended = vi.fn();
  const recorder = new DesktopVoiceRecorder(() => "", ended);
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 300 });
  port.dispatchEvent(new MessageEvent("message", { data: new Float32Array([0.2, -0.2]) }));
  track.dispatchEvent(new Event("ended"));
  expect(ended).toHaveBeenCalledWith(expect.stringContaining("disconnected"));
  await recorder.stop();
  expect(recorder.audio().length).toBe(48);
  expect(track.stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(port.close).toHaveBeenCalledOnce();
  track.dispatchEvent(new Event("ended"));
  expect(ended).toHaveBeenCalledTimes(1);
  recorder.clear();
  expect(recorder.uri).toBeNull();
});
