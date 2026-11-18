import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopLegacyLocalStorage from "../app/DesktopLegacyLocalStorage.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "./DesktopIpc.ts";
import { takeLegacyLocalStorage } from "./methods/legacyLocalStorage.ts";

it.effect("answers only app windows' top frames and hands sync handlers their sender", () =>
  Effect.gen(function* () {
    const primaryFrame = {};
    const secondaryFrame = {};
    const appWindows = [
      { webContents: { id: 1, mainFrame: primaryFrame } },
      { webContents: { id: 3, mainFrame: secondaryFrame } },
    ] as unknown as ReadonlyArray<Electron.BrowserWindow>;
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
              appWindowFor: (sender) =>
                Effect.succeed(
                  Option.fromNullishOr(
                    appWindows.find((window) => window.webContents.id === sender.id) ?? null,
                  ),
                ),
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
    yield* ipc.handleSync({
      channel: "token-sync",
      handler: (event) => Effect.succeed(`secret for ${event?.sender.id}`),
    });
    yield* ipc.handleSync(takeLegacyLocalStorage).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ElectronWindow.ElectronWindow, {
            primary: Effect.succeedSome(appWindows[0]!),
          }),
          Layer.mock(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage, {
            take: Effect.succeedSome({ theme: "dark" }),
          }),
        ),
      ),
    );

    const senders = {
      app: { sender: { id: 1 }, senderFrame: primaryFrame },
      secondApp: { sender: { id: 3 }, senderFrame: secondaryFrame },
      appSubframe: { sender: { id: 1 }, senderFrame: {} },
      previewGuest: { sender: { id: 2 }, senderFrame: {} },
    };
    const results: Record<string, unknown> = {};
    for (const [name, sender] of Object.entries(senders)) {
      const event = { ...sender, returnValue: "unset" as unknown };
      sync.get("token-sync")!(event);
      const legacy = { ...sender, returnValue: "unset" as unknown };
      sync.get(takeLegacyLocalStorage.channel)!(legacy);
      results[name] = [
        yield* Effect.promise(() =>
          Promise.resolve(invoke.get("token")!(sender, undefined)).catch(() => "rejected"),
        ),
        event.returnValue,
        legacy.returnValue,
      ];
    }
    assert.deepEqual(results, {
      app: ["secret", "secret for 1", { theme: "dark" }],
      secondApp: ["secret", "secret for 3", null],
      appSubframe: ["rejected", undefined, undefined],
      previewGuest: ["rejected", undefined, undefined],
    });
  }),
);
