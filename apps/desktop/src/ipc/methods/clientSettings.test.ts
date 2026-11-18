import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import { CLIENT_SETTINGS_CHANGED_CHANNEL } from "../channels.ts";
import { setClientSettings } from "./clientSettings.ts";

it.effect("tells every other app window that client settings changed", () =>
  Effect.gen(function* () {
    const notified: Array<[number, string]> = [];
    const appWindow = (id: number) =>
      ({
        webContents: { id, send: (channel: string) => void notified.push([id, channel]) },
      }) as unknown as Electron.BrowserWindow;
    yield* setClientSettings.handler(DEFAULT_CLIENT_SETTINGS, { sender: { id: 2 } }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ElectronWindow.ElectronWindow, {
            appWindows: Effect.succeed([appWindow(1), appWindow(2), appWindow(3)]),
          }),
          Layer.mock(DesktopClientSettings.DesktopClientSettings, { set: () => Effect.void }),
          Layer.mock(DesktopSnapShot.DesktopSnapShot, { configure: () => Effect.void }),
          Layer.mock(ElectronApp.ElectronApp, { preferredSystemLanguages: Effect.succeed(["en"]) }),
        ),
      ),
    );
    assert.deepEqual(notified, [
      [1, CLIENT_SETTINGS_CHANGED_CHANNEL],
      [3, CLIENT_SETTINGS_CHANGED_CHANNEL],
    ]);
  }),
);
