import { assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const { createFromBuffer, overlayImage, setBadgeCount } = vi.hoisted(() => ({
  createFromBuffer: vi.fn(),
  overlayImage: { isEmpty: vi.fn(() => false) },
  setBadgeCount: vi.fn(() => true),
}));

vi.mock("electron", () => ({
  app: { setBadgeCount },
  nativeImage: { createFromBuffer },
}));

vi.mock("effect/Effect", async (importOriginal) => {
  const actual = await importOriginal<typeof Effect>();
  return { ...actual, logWarning: vi.fn(() => actual.void) };
});

import { setDesktopUnreadBadge } from "./DesktopUnreadBadge.ts";

function makeWindow(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    setOverlayIcon: vi.fn(),
  };
}

describe("setDesktopUnreadBadge", () => {
  beforeEach(() => {
    createFromBuffer.mockReset();
    createFromBuffer.mockReturnValue(overlayImage);
    overlayImage.isEmpty.mockReset();
    overlayImage.isEmpty.mockReturnValue(false);
    setBadgeCount.mockReset();
    setBadgeCount.mockReturnValue(true);
  });

  it("sets and clears the Windows taskbar overlay", () => {
    const window = makeWindow();
    const badgeDataUrl = "data:image/png;base64,one";

    assert.isTrue(setDesktopUnreadBadge({ platform: "win32", window, count: 1, badgeDataUrl }));
    assert.deepEqual(createFromBuffer.mock.calls, [
      [Buffer.from("one", "base64"), { width: 64, height: 64, scaleFactor: 4 }],
    ]);
    assert.deepEqual(window.setOverlayIcon.mock.calls[0], [
      overlayImage,
      "1 completed thread awaiting review",
    ]);

    assert.isTrue(
      setDesktopUnreadBadge({
        platform: "win32",
        window,
        count: 0,
        badgeDataUrl: null,
      }),
    );
    assert.deepEqual(window.setOverlayIcon.mock.calls[1], [null, ""]);
  });

  it("uses the native badge count on macOS", () => {
    assert.isTrue(
      setDesktopUnreadBadge({ platform: "darwin", window: null, count: 2, badgeDataUrl: null }),
    );
    assert.isTrue(
      setDesktopUnreadBadge({ platform: "darwin", window: null, count: 0, badgeDataUrl: null }),
    );

    assert.deepEqual(setBadgeCount.mock.calls, [[2], [0]]);
    assert.lengthOf(createFromBuffer.mock.calls, 0);
  });

  it("returns the native result when macOS cannot show badge counts", () => {
    setBadgeCount.mockReturnValueOnce(false);

    assert.isFalse(
      setDesktopUnreadBadge({ platform: "darwin", window: null, count: 1, badgeDataUrl: null }),
    );
  });

  it("caches decoded Windows overlays", () => {
    const window = makeWindow();
    const badgeDataUrl = "data:image/png;base64,two";

    assert.isTrue(setDesktopUnreadBadge({ platform: "win32", window, count: 2, badgeDataUrl }));
    assert.isTrue(setDesktopUnreadBadge({ platform: "win32", window, count: 2, badgeDataUrl }));

    assert.equal(createFromBuffer.mock.calls.length, 1);
  });

  it("clears stale overlays for missing, malformed, and empty Windows badge images", () => {
    const window = makeWindow();

    assert.isFalse(
      setDesktopUnreadBadge({
        platform: "win32",
        window,
        count: 1,
        badgeDataUrl: null,
      }),
    );
    assert.isFalse(
      setDesktopUnreadBadge({
        platform: "win32",
        window,
        count: 1,
        badgeDataUrl: "data:image/svg+xml;base64,badge",
      }),
    );

    overlayImage.isEmpty.mockReturnValueOnce(true);
    assert.isFalse(
      setDesktopUnreadBadge({
        platform: "win32",
        window,
        count: 1,
        badgeDataUrl: "data:image/png;base64,empty",
      }),
    );
    assert.deepEqual(window.setOverlayIcon.mock.calls, [
      [null, ""],
      [null, ""],
      [null, ""],
    ]);
  });

  it("does nothing on unsupported platforms or without a live Windows window", () => {
    const window = makeWindow();
    const destroyedWindow = makeWindow(true);
    const badgeDataUrl = "data:image/png;base64,platform";

    assert.isFalse(
      setDesktopUnreadBadge({
        platform: "linux",
        window,
        count: 1,
        badgeDataUrl,
      }),
    );
    assert.isFalse(
      setDesktopUnreadBadge({
        platform: "win32",
        window: null,
        count: 1,
        badgeDataUrl,
      }),
    );
    assert.isFalse(
      setDesktopUnreadBadge({
        platform: "win32",
        window: destroyedWindow,
        count: 1,
        badgeDataUrl,
      }),
    );
    assert.lengthOf(window.setOverlayIcon.mock.calls, 0);
    assert.lengthOf(destroyedWindow.setOverlayIcon.mock.calls, 0);
    assert.lengthOf(setBadgeCount.mock.calls, 0);
  });

  it("fails soft when Electron rejects a badge update", () => {
    const warn = vi.mocked(Effect.logWarning);
    const window = makeWindow();
    window.setOverlayIcon.mockImplementation(() => {
      throw new Error("overlay failed");
    });

    assert.isFalse(
      setDesktopUnreadBadge({
        platform: "win32",
        window,
        count: 1,
        badgeDataUrl: "data:image/png;base64,failure",
      }),
    );

    setBadgeCount.mockImplementationOnce(() => {
      throw new Error("badge failed");
    });
    assert.isFalse(
      setDesktopUnreadBadge({ platform: "darwin", window: null, count: 1, badgeDataUrl: null }),
    );
    assert.deepEqual(warn.mock.calls, [
      ["Failed to update desktop unread badge", new Error("overlay failed")],
      ["Failed to update desktop unread badge", new Error("badge failed")],
    ]);
  });
});
