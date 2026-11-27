// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron webContents.
import { assert, describe, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { WEB_LINK_OPEN_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

const makeWindow = () => {
  const sent: Array<string> = [];
  const revealed: Array<unknown> = [];
  const open = () => {
    const webContents = Object.assign(new NodeEvents.EventEmitter(), {
      isDestroyed: () => false,
      send: (channel: string, url: string) => {
        if (channel === WEB_LINK_OPEN_CHANNEL) sent.push(url);
      },
    });
    return { webContents } as unknown as Electron.BrowserWindow;
  };
  let window = Option.some(open());
  const reload = () => {
    if (Option.isSome(window)) {
      window.value.webContents.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: false,
      });
    }
  };
  const close = () => {
    const closed = window;
    window = Option.none();
    if (Option.isSome(closed)) closed.value.webContents.emit("destroyed");
  };
  const reopen = () => {
    window = Option.some(open());
  };
  const layer = DesktopWebLinks.layer.pipe(
    Layer.provide(
      Layer.succeed(DesktopWindow.DesktopWindow, {
        activate: Effect.sync(() => void revealed.push(window)),
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    ),
    Layer.provide(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.sync(() => window),
          currentMainOrFirst: Effect.sync(() => window),
          reveal: (target: Electron.BrowserWindow) => Effect.sync(() => void revealed.push(target)),
        } as unknown as ElectronWindow.ElectronWindow["Service"]),
      ),
    ),
  );
  return { sent, revealed, layer, reload, close, reopen };
};

describe("DesktopWebLinks", () => {
  it.effect("holds links until the renderer listens, then delivers them in order", () => {
    const { sent, revealed, layer } = makeWindow();
    return Effect.gen(function* () {
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      yield* webLinks.receive("https://example.com/first");
      yield* webLinks.receive("https://example.com/second");
      assert.deepStrictEqual(sent, []);

      yield* webLinks.setRendererReady(true);
      assert.deepStrictEqual(sent, ["https://example.com/first", "https://example.com/second"]);
      assert.strictEqual(revealed.length, 1);

      yield* webLinks.receive("https://example.com/third");
      assert.deepStrictEqual(sent.at(-1), "https://example.com/third");

      yield* webLinks.setRendererReady(false);
      yield* webLinks.receive("https://example.com/fourth");
      assert.strictEqual(sent.length, 3);
      assert.strictEqual(revealed.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("holds links that arrive while the web app reloads until it listens again", () => {
    const { sent, layer, reload } = makeWindow();
    return Effect.gen(function* () {
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      yield* webLinks.setRendererReady(true);
      reload();
      yield* webLinks.receive("https://example.com/during-reload");
      assert.deepStrictEqual(sent, []);

      yield* webLinks.setRendererReady(true);
      assert.deepStrictEqual(sent, ["https://example.com/during-reload"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks for a window when a link arrives after the main window closed", () => {
    const { sent, revealed, layer, close, reopen } = makeWindow();
    return Effect.gen(function* () {
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      close();
      yield* webLinks.receive("https://example.com/at-launch");
      assert.strictEqual(revealed.length, 0);

      reopen();
      yield* webLinks.setRendererReady(true);
      assert.deepStrictEqual(sent, ["https://example.com/at-launch"]);
      assert.strictEqual(revealed.length, 1);

      close();
      yield* webLinks.receive("https://example.com/after-close");
      assert.deepStrictEqual(sent, ["https://example.com/at-launch"]);
      assert.strictEqual(revealed.length, 2);

      reopen();
      yield* webLinks.setRendererReady(true);
      assert.deepStrictEqual(sent, [
        "https://example.com/at-launch",
        "https://example.com/after-close",
      ]);
    }).pipe(Effect.provide(layer));
  });
});
