import { expect, it, vi } from "vite-plus/test";
import { requestMicrophone } from "./requestMicrophone";

function setup(input: {
  readonly getUserMedia: ReturnType<typeof vi.fn>;
  readonly platform?: string;
  readonly restartAudioService?: () => Promise<boolean>;
}) {
  const navigator = vi.spyOn(globalThis, "navigator", "get").mockReturnValue({
    mediaDevices: { getUserMedia: input.getUserMedia },
  } as unknown as Navigator);
  vi.stubGlobal("window", {
    desktopBridge: {
      getClientPlatform: () => input.platform ?? "linux",
      ...(input.restartAudioService ? { restartAudioService: input.restartAudioService } : {}),
    },
  });
  return {
    [Symbol.dispose]() {
      navigator.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

it("falls back to the system default for a missing microphone, but not permission denial", async () => {
  const media = {} as MediaStream;
  const getUserMedia = vi
    .fn()
    .mockRejectedValueOnce(new DOMException("gone", "OverconstrainedError"))
    .mockResolvedValueOnce(media);
  using _env = setup({ getUserMedia });
  await expect(requestMicrophone("blue-yeti")).resolves.toBe(media);
  expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true });
  const denied = new DOMException("denied", "NotAllowedError");
  getUserMedia.mockRejectedValueOnce(denied);
  await expect(requestMicrophone("blue-yeti")).rejects.toBe(denied);
  expect(getUserMedia).toHaveBeenCalledTimes(3);
});

it.each(["NotFoundError", "NotReadableError"])(
  "reopens the Linux desktop microphone once after %s",
  async (name) => {
    const stream = {} as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Disconnected", name))
      .mockResolvedValue(stream);
    const restartAudioService = vi.fn().mockResolvedValue(true);
    using _env = setup({ getUserMedia, restartAudioService });
    expect(await requestMicrophone("")).toBe(stream);
    expect(getUserMedia.mock.calls).toEqual([[{ audio: true }], [{ audio: true }]]);
    expect(restartAudioService).toHaveBeenCalledOnce();
  },
);

it.each([
  { name: "NotAllowedError", platform: "linux", recovered: true, calls: 1 },
  { name: "OverconstrainedError", platform: "linux", recovered: true, calls: 1 },
  { name: "NotFoundError", platform: "darwin", recovered: true, calls: 1 },
  { name: "NotFoundError", platform: "linux", recovered: false, calls: 1 },
  { name: "NotFoundError", platform: "linux", recovered: undefined, calls: 1 },
  { name: "NotReadableError", platform: "linux", recovered: true, calls: 2 },
])(
  "keeps $name on $platform (recovered: $recovered)",
  async ({ name, platform, recovered, calls }) => {
    const error = new DOMException("Unavailable", name);
    const getUserMedia = vi.fn().mockRejectedValue(error);
    using _env = setup({
      getUserMedia,
      platform,
      ...(recovered === undefined ? {} : { restartAudioService: async () => recovered }),
    });
    await expect(requestMicrophone("")).rejects.toBe(error);
    expect(getUserMedia).toHaveBeenCalledTimes(calls);
  },
);

it("keeps the system-default fallback across one Linux audio recovery", async () => {
  const missing = new DOMException("Disconnected", "NotFoundError");
  const stream = {} as MediaStream;
  const getUserMedia = vi
    .fn()
    .mockRejectedValueOnce(missing)
    .mockRejectedValueOnce(missing)
    .mockRejectedValueOnce(missing)
    .mockResolvedValueOnce(stream);
  const restartAudioService = vi.fn().mockResolvedValue(true);
  using _env = setup({ getUserMedia, restartAudioService });
  expect(await requestMicrophone("missing-mic")).toBe(stream);
  expect(getUserMedia.mock.calls).toEqual([
    [{ audio: { deviceId: { exact: "missing-mic" } } }],
    [{ audio: true }],
    [{ audio: { deviceId: { exact: "missing-mic" } } }],
    [{ audio: true }],
  ]);
  expect(restartAudioService).toHaveBeenCalledOnce();
});
