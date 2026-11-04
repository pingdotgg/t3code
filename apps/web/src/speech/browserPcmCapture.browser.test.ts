import { expect, it, vi } from "vite-plus/test";
import { createBrowserPcmCapture } from "./browserPcmCapture";

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
