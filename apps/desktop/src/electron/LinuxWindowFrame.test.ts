import { assert, describe, it } from "@effect/vitest";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import {
  isLinuxX11Session,
  readX11WmSupportedHints,
  resolveLinuxX11WindowFrameOptions,
} from "./LinuxWindowFrame.ts";

const hiddenTitleBarOptions = {
  width: 1100,
  height: 780,
  titleBarStyle: "hidden",
  titleBarOverlay: {
    color: "#01000000",
    height: 40,
    symbolColor: "#1f2937",
  },
} satisfies Electron.BrowserWindowConstructorOptions;

describe("LinuxWindowFrame", () => {
  it("resolves X11 from the Electron backend before desktop session environment", () => {
    const x11Environment = {
      DISPLAY: ":0",
      WAYLAND_DISPLAY: undefined,
      XDG_SESSION_TYPE: "x11",
    };
    const waylandEnvironment = {
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_SESSION_TYPE: "wayland",
    };

    assert.isTrue(isLinuxX11Session("linux", x11Environment));
    assert.isTrue(
      isLinuxX11Session("linux", {
        DISPLAY: ":0",
        WAYLAND_DISPLAY: undefined,
        XDG_SESSION_TYPE: undefined,
      }),
    );
    assert.isFalse(isLinuxX11Session("linux", waylandEnvironment));
    assert.isTrue(isLinuxX11Session("linux", waylandEnvironment, "x11"));
    assert.isFalse(isLinuxX11Session("linux", x11Environment, "wayland"));
    assert.isFalse(isLinuxX11Session("darwin", x11Environment, "x11"));
  });

  it("enforces a hard deadline when xprop never completes", async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn(() => true);
      const resultPromise = readX11WmSupportedHints({}, () => ({ kill }));

      await vi.advanceTimersByTimeAsync(250);

      assert.isNull(await resultPromise);
      assert.deepEqual(kill.mock.calls, [["SIGKILL"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to native decorations when an X11 WM lacks GTK frame extents", async () => {
    const readWmSupportedHints = vi.fn(() =>
      "_NET_SUPPORTED(ATOM) = _NET_ACTIVE_WINDOW, _NET_WM_STATE",
    );

    const resolved = await resolveLinuxX11WindowFrameOptions({
      options: hiddenTitleBarOptions,
      platform: "linux",
      env: { DISPLAY: ":0", WAYLAND_DISPLAY: undefined, XDG_SESSION_TYPE: "x11" },
      readWmSupportedHints,
    });

    assert.deepEqual(resolved, {
      width: 1100,
      height: 780,
      frame: true,
    });
    assert.equal(readWmSupportedHints.mock.calls.length, 1);
  });

  it("does not accept similarly named GTK frame extent atoms", async () => {
    const resolved = await resolveLinuxX11WindowFrameOptions({
      options: hiddenTitleBarOptions,
      platform: "linux",
      env: { DISPLAY: ":0", WAYLAND_DISPLAY: undefined, XDG_SESSION_TYPE: "x11" },
      readWmSupportedHints: () =>
        "_NET_SUPPORTED(ATOM) = _NET_ACTIVE_WINDOW, _GTK_FRAME_EXTENTS_V2, _NET_WM_STATE",
    });

    assert.deepEqual(resolved, {
      width: 1100,
      height: 780,
      frame: true,
    });
  });

  it("falls back when Electron is explicitly forced to X11 from Wayland", async () => {
    const resolved = await resolveLinuxX11WindowFrameOptions({
      options: hiddenTitleBarOptions,
      platform: "linux",
      env: { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" },
      ozonePlatform: "x11",
      readWmSupportedHints: () => "_NET_SUPPORTED(ATOM) = _NET_ACTIVE_WINDOW",
    });

    assert.deepEqual(resolved, {
      width: 1100,
      height: 780,
      frame: true,
    });
  });

  it("keeps client decorations when the X11 WM supports GTK frame extents", async () => {
    const resolved = await resolveLinuxX11WindowFrameOptions({
      options: hiddenTitleBarOptions,
      platform: "linux",
      env: { DISPLAY: ":0", WAYLAND_DISPLAY: undefined, XDG_SESSION_TYPE: "x11" },
      readWmSupportedHints: () =>
        "_NET_SUPPORTED(ATOM) = _NET_ACTIVE_WINDOW, _GTK_FRAME_EXTENTS, _NET_WM_STATE",
    });

    assert.strictEqual(resolved, hiddenTitleBarOptions);
  });

  it("fails open when X11 support cannot be inspected", async () => {
    const resolved = await resolveLinuxX11WindowFrameOptions({
      options: hiddenTitleBarOptions,
      platform: "linux",
      env: { DISPLAY: ":0", WAYLAND_DISPLAY: undefined, XDG_SESSION_TYPE: "x11" },
      readWmSupportedHints: () => null,
    });

    assert.strictEqual(resolved, hiddenTitleBarOptions);
  });

  it("does not probe or alter Wayland and non-hidden windows", async () => {
    const readWmSupportedHints = vi.fn(() => "");

    const wayland = await resolveLinuxX11WindowFrameOptions({
      options: hiddenTitleBarOptions,
      platform: "linux",
      env: { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" },
      readWmSupportedHints,
    });
    const native = await resolveLinuxX11WindowFrameOptions({
      options: { width: 800, height: 600, frame: true },
      platform: "linux",
      env: { DISPLAY: ":0", WAYLAND_DISPLAY: undefined, XDG_SESSION_TYPE: "x11" },
      readWmSupportedHints,
    });

    assert.strictEqual(wayland, hiddenTitleBarOptions);
    assert.deepEqual(native, { width: 800, height: 600, frame: true });
    assert.equal(readWmSupportedHints.mock.calls.length, 0);
  });
});
