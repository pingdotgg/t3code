import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, vi } from "vite-plus/test";

const windows = vi.hoisted(() =>
  [1, 2].map((id) => ({
    isDestroyed: () => false,
    webContents: { id, send: vi.fn() },
  })),
);
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => windows } }));

import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import { setClientSettings } from "./clientSettings.ts";

it.effect("a save is written once and sent to no window, so none saves again in reply", () => {
  const written: unknown[] = [];
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    browserProfiles: [{ id: "work", name: "Client work", kind: "persistent" as const }],
  };
  return Effect.gen(function* () {
    yield* setClientSettings.handler(settings, { sender: { id: 1 } } as never);
    expect(written).toEqual([settings]);
    for (const window of windows) expect(window.webContents.send).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopClientSettings.DesktopClientSettings, {
          set: (value: unknown) => Effect.sync(() => void written.push(value)),
        } as unknown as DesktopClientSettings.DesktopClientSettings["Service"]),
        Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
          configure: () => Effect.void,
        } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
      ),
    ),
  );
});
