import * as Effect from "effect/Effect";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const native = vi.hoisted(() => ({
  setBadgeCount: vi.fn(),
  setOverlayIcon: vi.fn(),
  isDestroyed: vi.fn(() => false),
  getFocusedWindow: vi.fn(() => null as object | null),
  image: { isEmpty: vi.fn(() => false) },
  createFromDataURL: vi.fn(),
  webContents: { send: vi.fn() },
  listeners: new Map<string, () => void>(),
}));
vi.mock("electron", () => ({
  app: {
    setBadgeCount: native.setBadgeCount,
    on: (event: string, listener: () => void) => native.listeners.set(event, listener),
    removeListener: (event: string) => native.listeners.delete(event),
  },
  BrowserWindow: {
    getFocusedWindow: native.getFocusedWindow,
    getAllWindows: () => [native],
  },
  nativeImage: { createFromDataURL: native.createFromDataURL },
}));

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { applyNotificationBadge, installNotificationBadge } from "./notificationBadge.ts";

const badge = { count: 2, image: "data:image/png;base64,aGVsbG8=" };

beforeEach(() => {
  vi.clearAllMocks();
  native.getFocusedWindow.mockReturnValue(null);
  native.isDestroyed.mockReturnValue(false);
  native.image.isEmpty.mockReturnValue(false);
  native.createFromDataURL.mockReturnValue(native.image);
  native.setBadgeCount.mockImplementation(() => true);
  native.listeners.clear();
});

it.each(["darwin", "linux"] as const)("sets and clears the native %s count", (platform) => {
  applyNotificationBadge(platform, badge);
  applyNotificationBadge(platform, { count: 0, image: null });
  expect(native.setBadgeCount.mock.calls).toEqual([[2], [0]]);
  expect(native.createFromDataURL).not.toHaveBeenCalled();
});

it("sets and clears the Windows taskbar overlay", () => {
  applyNotificationBadge("win32", badge);
  expect(native.setOverlayIcon).toHaveBeenLastCalledWith(
    native.image,
    "2 threads with new notifications",
  );
  applyNotificationBadge("win32", { count: 0, image: null });
  expect(native.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
});

it.each(["win32", "darwin", "linux"] as const)(
  "rejects a late positive count while %s is focused",
  (platform) => {
    native.getFocusedWindow.mockReturnValue({});
    applyNotificationBadge(platform, badge);
    if (platform === "win32") expect(native.setOverlayIcon).toHaveBeenCalledWith(null, "");
    else expect(native.setBadgeCount).toHaveBeenCalledWith(0);
    expect(native.createFromDataURL).not.toHaveBeenCalled();
  },
);

it("ignores destroyed windows and clears invalid images", () => {
  native.isDestroyed.mockReturnValue(true);
  applyNotificationBadge("win32", badge);
  expect(native.setOverlayIcon).not.toHaveBeenCalled();
  native.isDestroyed.mockReturnValue(false);
  native.image.isEmpty.mockReturnValue(true);
  applyNotificationBadge("win32", badge);
  expect(native.setOverlayIcon.mock.calls[0]?.[0]).toBeNull();
});

it("keeps notifications working when the native badge API fails", () => {
  native.setBadgeCount.mockImplementation(() => {
    throw new Error("Unavailable");
  });
  expect(() => applyNotificationBadge("linux", badge)).not.toThrow();
});

it.effect("validates IPC and clears on native focus, quit, and disposal", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installNotificationBadge();
        const handler = handlers.get("desktop:set-notification-badge")!;
        const event = { sender: { id: 1 } };
        for (const invalid of [
          { ...badge, count: -1 },
          { ...badge, count: 0.5 },
          { ...badge, count: Infinity },
          { ...badge, image: "https://example.com/icon.png" },
          { ...badge, image: `data:image/png;base64,${"a".repeat(16_384)}` },
        ]) {
          yield* Effect.promise(() => expect(handler(event, invalid)).rejects.toBeDefined());
        }
        expect(native.setBadgeCount).not.toHaveBeenCalled();
        yield* Effect.promise(() => Promise.resolve(handler(event, badge)));
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(2);
        native.listeners.get("browser-window-focus")!();
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
        expect(native.webContents.send).toHaveBeenCalledWith("desktop:set-notification-badge");
        native.getFocusedWindow.mockReturnValue({});
        yield* Effect.promise(() => Promise.resolve(handler(event, badge)));
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
        expect(native.webContents.send).toHaveBeenCalledTimes(2);
        yield* Effect.promise(() => Promise.resolve(handler(event, { count: 0, image: null })));
        expect(native.webContents.send).toHaveBeenCalledTimes(2);
        native.getFocusedWindow.mockReturnValue(null);
        yield* Effect.promise(() => Promise.resolve(handler(event, badge)));
        native.listeners.get("before-quit")!();
        expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
      }),
    ).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provide([
        ElectronApp.layer,
        DesktopIpc.layer({
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
          removeHandler: (channel) => {
            handlers.delete(channel);
          },
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        }),
      ]),
    );
    expect(native.setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(native.listeners.size).toBe(0);
    expect(handlers.size).toBe(0);
  }),
);
