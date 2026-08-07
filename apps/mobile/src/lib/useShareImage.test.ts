import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  shareImage: vi.fn(),
}));

vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
}));

vi.mock("./fullScreenImageActions", () => ({
  shareImage: mocks.shareImage,
}));

import { shareImageExclusively } from "./useShareImage";

describe("shareImageExclusively", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores a second request while a sheet is already open", async () => {
    let release: (() => void) | undefined;
    mocks.shareImage.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ok: true });
      }),
    );

    // Two different thumbnails long-pressed before the first sheet appears.
    const first = shareImageExclusively({ uri: "https://example.test/a.png" });
    const second = shareImageExclusively({ uri: "https://example.test/b.png" });

    expect(mocks.shareImage).toHaveBeenCalledTimes(1);

    release?.();
    await Promise.all([first, second]);
  });

  it("allows a new share once the previous one settles", async () => {
    mocks.shareImage.mockResolvedValue({ ok: true });

    await shareImageExclusively({ uri: "https://example.test/a.png" });
    await shareImageExclusively({ uri: "https://example.test/b.png" });

    expect(mocks.shareImage).toHaveBeenCalledTimes(2);
  });

  it("releases the guard when a share fails, and surfaces the message", async () => {
    mocks.shareImage.mockResolvedValue({ ok: false, message: "Couldn't share the image." });

    await shareImageExclusively({ uri: "https://example.test/a.png" });

    expect(mocks.alert).toHaveBeenCalledWith("Couldn't share the image.");

    mocks.shareImage.mockResolvedValue({ ok: true });
    await shareImageExclusively({ uri: "https://example.test/b.png" });

    expect(mocks.shareImage).toHaveBeenCalledTimes(2);
  });

  it("expires the lock so a sheet that never settles cannot disable sharing", async () => {
    vi.useFakeTimers();
    try {
      // A share that hangs forever, as some Android targets do after a cancel.
      mocks.shareImage.mockReturnValueOnce(new Promise(() => {}));
      void shareImageExclusively({ uri: "https://example.test/a.png" });
      expect(mocks.shareImage).toHaveBeenCalledTimes(1);

      // Still held while the lock is fresh.
      vi.setSystemTime(Date.now() + 59_000);
      void shareImageExclusively({ uri: "https://example.test/b.png" });
      expect(mocks.shareImage).toHaveBeenCalledTimes(1);

      // Released once it goes stale.
      vi.setSystemTime(Date.now() + 2_000);
      mocks.shareImage.mockResolvedValue({ ok: true });
      await shareImageExclusively({ uri: "https://example.test/c.png" });
      expect(mocks.shareImage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stale share release the lock a newer share holds", async () => {
    vi.useFakeTimers();
    try {
      let releaseStale: (() => void) | undefined;
      mocks.shareImage.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseStale = () => resolve({ ok: true });
        }),
      );
      // A hangs and its lock goes stale.
      void shareImageExclusively({ uri: "https://example.test/a.png" });
      vi.setSystemTime(Date.now() + 61_000);

      // B takes the lock.
      let releaseCurrent: (() => void) | undefined;
      mocks.shareImage.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseCurrent = () => resolve({ ok: true });
        }),
      );
      const current = shareImageExclusively({ uri: "https://example.test/b.png" });
      expect(mocks.shareImage).toHaveBeenCalledTimes(2);

      // A finally settles. It must not clear B's lock.
      releaseStale?.();
      await Promise.resolve();
      await Promise.resolve();

      void shareImageExclusively({ uri: "https://example.test/c.png" });
      expect(mocks.shareImage).toHaveBeenCalledTimes(2);

      // Leave the module-level lock free for the next test.
      releaseCurrent?.();
      await current;
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the guard when shareImage throws", async () => {
    mocks.shareImage.mockRejectedValue(new Error("boom"));

    await expect(shareImageExclusively({ uri: "https://example.test/a.png" })).rejects.toThrow();

    mocks.shareImage.mockResolvedValue({ ok: true });
    await shareImageExclusively({ uri: "https://example.test/b.png" });

    expect(mocks.shareImage).toHaveBeenCalledTimes(2);
  });
});
