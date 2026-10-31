import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import * as Electron from "electron";
import * as ElectronTray from "./ElectronTray.ts";

vi.mock("electron", () => ({ Tray: vi.fn(), Menu: { buildFromTemplate: vi.fn() } }));

describe("ElectronTray", () => {
  it.effect.each(["success", "constructor", "menu"] as const)(
    "releases native resources when setup outcome is %s",
    (outcome) =>
      Effect.gen(function* () {
        const destroy = vi.fn();
        const setContextMenu = vi.fn(() => {
          if (outcome === "menu") throw new Error("menu unavailable");
        });
        vi.mocked(Electron.Tray).mockImplementation(function () {
          if (outcome === "constructor") throw new Error("tray unavailable");
          return {
            destroy,
            setContextMenu,
            setToolTip: vi.fn(),
            on: vi.fn(),
          } as unknown as Electron.Tray;
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const tray = yield* ElectronTray.ElectronTray;
            const created = yield* tray.create({
              icon: "icon.ico",
              name: "T3 Code",
              open: () => {},
              quit: () => {},
            });
            assert.equal(created, outcome === "success");
            assert.equal(destroy.mock.calls.length, outcome === "menu" ? 1 : 0);
          }).pipe(Effect.provide(ElectronTray.layer)),
        );
        assert.equal(destroy.mock.calls.length, outcome === "constructor" ? 0 : 1);
      }),
  );
});
