import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const { menu } = vi.hoisted(() => ({
  menu: { template: [] as Electron.MenuItemConstructorOptions[] },
}));

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
      menu.template = template;
      return { popup: (options: Electron.PopupOptions) => options.callback?.() };
    },
  },
}));

import * as ElectronMenu from "./ElectronMenu.ts";

describe("ElectronMenu", () => {
  it.effect("shows ampersands in labels instead of reading them as mnemonics", () =>
    Effect.gen(function* () {
      const electronMenu = yield* ElectronMenu.make;
      yield* electronMenu.showContextMenu({
        window: { webContents: { getZoomFactor: () => 1 } } as Electron.BrowserWindow,
        items: [
          { id: "filter", label: "Filter by R&D" },
          { id: "more", label: "A&B", children: [{ id: "child", label: "C && D" }] },
        ],
        position: Option.none(),
        source: Option.none(),
      });

      assert.deepEqual(
        menu.template.map((item) => item.label),
        ["Filter by R&&D", "A&&B"],
      );
      const submenu = menu.template[1]!.submenu as Electron.MenuItemConstructorOptions[];
      assert.equal(submenu[0]!.label, "C &&&& D");
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );
});
