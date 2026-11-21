import { expect, it, vi } from "vite-plus/test";
import { stubGlobal } from "../../test/render";
import { createBrowserPcmCapture } from "./browserPcmCapture";
import { requestMicrophone } from "./requestMicrophone";

it.each(["cancel", "worklet failure"] as const)(
  "releases an unanswered microphone prompt after %s",
  async (failure) => {
    let grantPermission!: (media: MediaStream) => void;
    const permission = new Promise<MediaStream>((resolve) => {
      grantPermission = resolve;
    });
    using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(permission);
    const module = Promise.withResolvers<void>();
    const addModule = vi.fn(() => module.promise);
    const close = vi.fn(async () => {});
    using _context = stubGlobal(
      "AudioContext",
      class {
        audioWorklet = { addModule };
        close = close;
      },
    );
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
    expect(addModule).toHaveBeenCalledOnce();
    const error = new Error("Worklet unavailable");
    if (failure === "cancel") abort.abort();
    else module.reject(error);
    const stop = vi.fn();
    try {
      await vi.waitFor(() =>
        expect(rejected).toHaveBeenCalledWith(failure === "cancel" ? abort.signal.reason : error),
      );
    } finally {
      module.resolve();
      grantPermission({ getTracks: () => [{ stop }] } as unknown as MediaStream);
      await preparing;
    }
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(close).toHaveBeenCalledOnce();
  },
);

it("falls back to the system default when the saved microphone is gone, and reports other failures", async () => {
  const media = {} as MediaStream;
  using microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockRejectedValueOnce(new DOMException("gone", "OverconstrainedError"))
    .mockResolvedValueOnce(media);
  await expect(requestMicrophone("blue-yeti")).resolves.toBe(media);
  expect(microphone).toHaveBeenLastCalledWith({ audio: true });

  const denied = new DOMException("denied", "NotAllowedError");
  microphone.mockRejectedValueOnce(denied);
  await expect(requestMicrophone("blue-yeti")).rejects.toBe(denied);
  expect(microphone).toHaveBeenCalledTimes(3);
});
