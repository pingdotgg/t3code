import { expect, it, vi } from "vite-plus/test";
import { requestMicrophone } from "./requestMicrophone";

it.each(["NotFoundError", "NotReadableError"])(
  "reopens the Linux desktop microphone after %s without restarting the app",
  async (name) => {
    const stream = {} as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Disconnected", name))
      .mockResolvedValue(stream);
    const restartAudioService = vi.fn().mockResolvedValue(true);
    using _navigator = vi
      .spyOn(globalThis, "navigator", "get")
      .mockReturnValue({ mediaDevices: { getUserMedia } } as unknown as Navigator);
    vi.stubGlobal("window", {
      desktopBridge: { getClientPlatform: () => "linux", restartAudioService },
    });
    try {
      expect(await requestMicrophone("selected-mic")).toBe(stream);
      expect(getUserMedia.mock.calls).toEqual([
        [{ audio: { deviceId: { exact: "selected-mic" } } }],
        [{ audio: { deviceId: { exact: "selected-mic" } } }],
      ]);
      expect(restartAudioService).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it.each(["NotAllowedError", "OverconstrainedError"])(
  "preserves %s without restarting audio",
  async (name) => {
    const error = new DOMException("Unavailable", name);
    const getUserMedia = vi.fn().mockRejectedValue(error);
    const restartAudioService = vi.fn();
    using _navigator = vi
      .spyOn(globalThis, "navigator", "get")
      .mockReturnValue({ mediaDevices: { getUserMedia } } as unknown as Navigator);
    vi.stubGlobal("window", {
      desktopBridge: { getClientPlatform: () => "linux", restartAudioService },
    });
    try {
      await expect(requestMicrophone("")).rejects.toBe(error);
      expect(restartAudioService).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  { platform: "darwin", recovered: true },
  { platform: "win32", recovered: true },
  { platform: "linux", recovered: false },
  { platform: "linux", recovered: undefined },
])(
  "preserves the failure when recovery is unavailable ($platform, $recovered)",
  async ({ platform, recovered }) => {
    const error = new DOMException("Missing microphone", "NotFoundError");
    const getUserMedia = vi.fn().mockRejectedValue(error);
    using _navigator = vi
      .spyOn(globalThis, "navigator", "get")
      .mockReturnValue({ mediaDevices: { getUserMedia } } as unknown as Navigator);
    vi.stubGlobal("window", {
      desktopBridge: {
        getClientPlatform: () => platform,
        ...(recovered === undefined ? {} : { restartAudioService: async () => recovered }),
      },
    });
    try {
      await expect(requestMicrophone("")).rejects.toBe(error);
      expect(getUserMedia).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("only retries capture once after recovery", async () => {
  const error = new DOMException("Still unavailable", "NotReadableError");
  const getUserMedia = vi.fn().mockRejectedValue(error);
  const restartAudioService = vi.fn().mockResolvedValue(true);
  using _navigator = vi
    .spyOn(globalThis, "navigator", "get")
    .mockReturnValue({ mediaDevices: { getUserMedia } } as unknown as Navigator);
  vi.stubGlobal("window", {
    desktopBridge: { getClientPlatform: () => "linux", restartAudioService },
  });
  try {
    await expect(requestMicrophone("")).rejects.toBe(error);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(restartAudioService).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
