import { expect, it, vi } from "vite-plus/test";
import { createBrowserPcmCapture } from "./browserPcmCapture";

it.each(["cancel", "worklet failure"] as const)(
  "releases an unanswered microphone prompt after %s",
  async (failure) => {
    const permission = Promise.withResolvers<MediaStream>();
    const requested = Promise.withResolvers<MediaStreamConstraints>();
    const stopped = Promise.withResolvers<void>();
    const microphone = (constraints: MediaStreamConstraints) => {
      requested.resolve(constraints);
      return permission.promise;
    };
    using _navigator = vi.spyOn(globalThis, "navigator", "get").mockReturnValue({
      mediaDevices: { getUserMedia: microphone },
    } as unknown as Navigator);
    const module = Promise.withResolvers<void>();
    const addModule = vi.fn(() => module.promise);
    const close = vi.fn(async () => {});
    vi.stubGlobal(
      "AudioContext",
      class {
        audioWorklet = { addModule };
        close = close;
      },
    );
    using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
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
    const preparing = capture.recorder.prepareToRecordAsync(abort.signal);
    expect(await Promise.race([requested.promise, preparing])).toEqual({
      audio: { deviceId: { exact: "blue-yeti" } },
    });
    expect(addModule).toHaveBeenCalledOnce();
    const error = new Error("Worklet unavailable");
    if (failure === "cancel") abort.abort();
    else module.reject(error);
    const stop = vi.fn(stopped.resolve);
    try {
      await expect(preparing).rejects.toBe(failure === "cancel" ? abort.signal.reason : error);
    } finally {
      module.resolve();
      permission.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    }
    await stopped.promise;
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
);
