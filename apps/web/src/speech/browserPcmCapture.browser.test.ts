import { expect, it, vi } from "vite-plus/test";
import { createBrowserPcmCapture, openMicrophone } from "./browserPcmCapture";

it("records from the chosen microphone, cancels an unanswered prompt, and stops a late stream", async () => {
  let grantPermission!: (media: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    grantPermission = resolve;
  });
  using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(permission);
  const capture = createBrowserPcmCapture(
    {
      getMicrophoneId: async () => "blue-yeti",
      onLevel: vi.fn(),
      onDurationLimit: vi.fn(),
      onError: vi.fn(),
    },
    async () => ({ locale: "en", transcribe: async () => "" }),
  );
  const abort = new AbortController();
  await capture.transcriber.prepare({ signal: abort.signal });
  const rejected = vi.fn();
  const preparing = capture.recorder.prepareToRecordAsync(abort.signal).catch(rejected);
  await vi.waitFor(() =>
    expect(microphone).toHaveBeenCalledExactlyOnceWith({
      audio: { deviceId: { exact: "blue-yeti" } },
    }),
  );
  abort.abort();
  const stop = vi.fn();
  try {
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(abort.signal.reason));
  } finally {
    grantPermission({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await preparing;
  }
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
});

it("falls back to the system default when the saved microphone is gone, and reports other failures", async () => {
  const media = {} as MediaStream;
  using microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockRejectedValueOnce(new DOMException("gone", "OverconstrainedError"))
    .mockResolvedValueOnce(media);
  await expect(openMicrophone("blue-yeti")).resolves.toBe(media);
  expect(microphone).toHaveBeenLastCalledWith({ audio: true });

  const denied = new DOMException("denied", "NotAllowedError");
  microphone.mockRejectedValueOnce(denied);
  await expect(openMicrophone("blue-yeti")).rejects.toBe(denied);
  expect(microphone).toHaveBeenCalledTimes(3);
});
