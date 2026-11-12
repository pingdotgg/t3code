import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "./DesktopIpc.ts";

const popout = (id: number, url: string) => {
  const mainFrame = {};
  return {
    sender: { id, getType: () => "window", getURL: () => url, mainFrame },
    senderFrame: mainFrame,
  };
};

it.effect("answers only the app's own windows' top frames", () =>
  Effect.gen(function* () {
    const mainFrame = {};
    const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
    const ipc = yield* DesktopIpc.DesktopIpc.pipe(
      Effect.provide(
        DesktopIpc.layer({
          removeHandler: (channel) => void invoke.delete(channel),
          handle: (channel, listener) => void invoke.set(channel, listener),
          removeAllListeners: (channel) => void sync.delete(channel),
          on: (channel, listener) => void sync.set(channel, listener),
        }).pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow, {
              main: Effect.succeedSome({
                webContents: { id: 1, mainFrame, getURL: () => "t3://app/index.html#/" },
              } as unknown as Electron.BrowserWindow),
            }),
          ),
        ),
      ),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: "token",
        payload: Schema.Void,
        result: Schema.String,
        handler: () => Effect.succeed("secret"),
      }),
    );
    yield* ipc.handleSync({ channel: "token-sync", handler: () => Effect.succeed("secret") });

    const senders = {
      app: { sender: { id: 1 }, senderFrame: mainFrame },
      appSubframe: { sender: { id: 1 }, senderFrame: {} },
      previewGuest: { sender: { id: 2 }, senderFrame: {} },
      popout: popout(3, "t3://app/index.html#/browser-window/tab-1"),
      popoutSubframe: {
        ...popout(3, "t3://app/index.html#/browser-window/tab-1"),
        senderFrame: {},
      },
      popoutOnAppRoute: popout(3, "t3://app/index.html#/settings"),
      foreignWindow: popout(4, "https://example.com/#/browser-window/tab-1"),
      blankWindow: popout(6, "about:blank#/browser-window/tab-1"),
      otherHost: popout(7, "t3://other/index.html#/browser-window/tab-1"),
      fileWindow: popout(8, "file:///index.html#/browser-window/tab-1"),
      guestOnAppUrl: {
        ...popout(5, "t3://app/index.html#/browser-window/tab-1"),
        sender: { ...popout(5, "").sender, getType: () => "webview" },
      },
    };
    const results: Record<string, unknown> = {};
    for (const [name, sender] of Object.entries(senders)) {
      const event = { ...sender, returnValue: "unset" as unknown };
      sync.get("token-sync")!(event);
      results[name] = [
        yield* Effect.promise(() =>
          Promise.resolve(invoke.get("token")!(sender, undefined)).catch(() => "rejected"),
        ),
        event.returnValue,
      ];
    }
    assert.deepEqual(results, {
      app: ["secret", "secret"],
      appSubframe: ["rejected", undefined],
      previewGuest: ["rejected", undefined],
      popout: ["secret", "secret"],
      popoutSubframe: ["rejected", undefined],
      popoutOnAppRoute: ["rejected", undefined],
      foreignWindow: ["rejected", undefined],
      blankWindow: ["rejected", undefined],
      otherHost: ["rejected", undefined],
      fileWindow: ["rejected", undefined],
      guestOnAppUrl: ["rejected", undefined],
    });
  }).pipe(Effect.scoped),
);
