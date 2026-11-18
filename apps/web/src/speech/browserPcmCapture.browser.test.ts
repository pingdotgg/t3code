import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { createBrowserPcmCapture } from "./browserPcmCapture";
import { requestMicrophone } from "./requestMicrophone";

it("records from the chosen microphone, cancels an unanswered prompt, and stops a late stream", async () => {
  let grantPermission!: (media: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    grantPermission = resolve;
  });
  using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(permission);
  using close = vi.spyOn(AudioContext.prototype, "close");
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
    expect(close).toHaveBeenCalledOnce();
  } finally {
    grantPermission({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await preparing;
  }
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
});

it("opens the microphone while the destination is prepared and releases it as soon as the start is abandoned", async () => {
  const stop = vi.fn();
  const media = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  let grantMicrophone!: (stream: MediaStream) => void;
  using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(
    () =>
      new Promise((resolve) => {
        grantMicrophone = resolve;
      }),
  );
  using close = vi.spyOn(AudioContext.prototype, "close");
  using _worklet = vi
    .spyOn(AudioWorklet.prototype, "addModule")
    .mockReturnValue(new Promise(() => undefined));
  let failPreparation!: (error: Error) => void;
  const capture = createBrowserPcmCapture(
    { getMicrophoneId: () => "", onLevel: vi.fn(), onDurationLimit: vi.fn(), onError: vi.fn() },
    () =>
      new Promise((_resolve, reject) => {
        failPreparation = reject;
      }),
  );

  const unavailable = new Error("Voice transcription is not available.");
  const failing = capture.transcriber.prepare({ signal: new AbortController().signal });
  await vi.waitFor(() => expect(microphone).toHaveBeenCalledExactlyOnceWith({ audio: true }));
  failPreparation(unavailable);
  await expect(failing).rejects.toBe(unavailable);
  expect(close).toHaveBeenCalledOnce();
  grantMicrophone(media);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());

  const cancelled = new AbortController();
  microphone.mockResolvedValueOnce(media);
  void capture.transcriber.prepare({ signal: cancelled.signal }).catch(() => undefined);
  await vi.waitFor(() => expect(microphone).toHaveBeenCalledTimes(2));
  cancelled.abort();
  expect(stop).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
});

it("reports microphone and worklet failures when recording starts and releases what it opened", async () => {
  const denied = new DOMException("denied", "NotAllowedError");
  using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockRejectedValue(denied);
  using close = vi.spyOn(AudioContext.prototype, "close");
  const capture = createBrowserPcmCapture(
    { getMicrophoneId: () => "", onLevel: vi.fn(), onDurationLimit: vi.fn(), onError: vi.fn() },
    async () => ({ locale: "en", transcribe: async () => "" }),
  );
  const abort = new AbortController();
  await capture.transcriber.prepare({ signal: abort.signal });
  await expect(capture.recorder.prepareToRecordAsync(abort.signal)).rejects.toBe(denied);
  expect(close).toHaveBeenCalledOnce();

  const stop = vi.fn();
  microphone.mockResolvedValue({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  // Insecure origins expose AudioContext without audioWorklet.
  using _insecure = vi
    .spyOn(BaseAudioContext.prototype, "audioWorklet", "get")
    .mockReturnValue(undefined as unknown as AudioWorklet);
  const retry = new AbortController();
  await capture.transcriber.prepare({ signal: retry.signal });
  await expect(capture.recorder.prepareToRecordAsync(retry.signal)).rejects.toBeInstanceOf(
    TypeError,
  );
  expect(stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledTimes(2);
});

it("records through an audio context that opens no output device", async () => {
  // Audio contexts only run after user activation, which the microphone button provides.
  await userEvent.click(document.body);
  const silentSource: AudioContextOptions & { readonly sinkId: { readonly type: "none" } } = {
    sinkId: { type: "none" },
  };
  const source = new AudioContext(silentSource);
  using _microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockResolvedValue(source.createMediaStreamDestination().stream);
  using contexts = vi.spyOn(window, "AudioContext");
  const onLevel = vi.fn();
  const onError = vi.fn();
  const capture = createBrowserPcmCapture(
    { getMicrophoneId: () => "", onLevel, onDurationLimit: vi.fn(), onError },
    async () => ({ locale: "en", transcribe: async () => "" }),
  );
  try {
    const abort = new AbortController();
    await capture.transcriber.prepare({ signal: abort.signal });
    await capture.recorder.prepareToRecordAsync(abort.signal);
    expect(contexts.mock.instances[0]).toHaveProperty("sinkId.type", "none");
    capture.recorder.record({ forDuration: 60 });
    await vi.waitFor(() => expect(onLevel).toHaveBeenCalled());
    await capture.recorder.stop();
    expect(capture.recorder.uri).not.toBeNull();

    const disconnected = source.createMediaStreamDestination().stream;
    _microphone.mockResolvedValueOnce(disconnected);
    const retry = new AbortController();
    await capture.transcriber.prepare({ signal: retry.signal });
    disconnected.getTracks().forEach((track) => track.stop());
    await expect(capture.recorder.prepareToRecordAsync(retry.signal)).rejects.toThrow(
      "The microphone disconnected.",
    );
    expect(onError).toHaveBeenCalledWith("The microphone disconnected.", "microphone-disconnected");
  } finally {
    capture.cancelRecording();
    await source.close();
  }
});

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
