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

const makeAppWindow = () => {
  const sent: Array<string> = [];
  let destroyed = false;
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    isDestroyed: () => destroyed,
    send: (channel: string, url: string) => {
      if (channel === WEB_LINK_OPEN_CHANNEL) sent.push(url);
    },
  });
  const window = { webContents, isDestroyed: () => destroyed } as unknown as Electron.BrowserWindow;
  const reload = () =>
    webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  const close = () => {
    destroyed = true;
    webContents.emit("destroyed");
  };
  return { window, sent, reload, close };
};

const makeLayer = (windows: ReadonlyArray<ReturnType<typeof makeAppWindow>>) => {
  const revealed: Array<unknown> = [];
  const current = Effect.sync(() =>
    Option.fromNullishOr(windows.find(({ window }) => !window.isDestroyed())?.window ?? null),
  );
  const layer = DesktopWebLinks.layer.pipe(
    Layer.provide(
      Layer.succeed(DesktopWindow.DesktopWindow, {
        activate: Effect.flatMap(current, (window) =>
          Effect.sync(() => void revealed.push(Option.getOrNull(window))),
        ),
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
    ),
    Layer.provide(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          currentAppWindow: current,
          reveal: (target: Electron.BrowserWindow) => Effect.sync(() => void revealed.push(target)),
        } as unknown as ElectronWindow.ElectronWindow["Service"]),
      ),
    ),
  );
  return { revealed, layer };
};

describe("DesktopWebLinks", () => {
  it.effect("holds links until the renderer listens, then delivers them in order", () => {
    const app = makeAppWindow();
    const { revealed, layer } = makeLayer([app]);
    return Effect.gen(function* () {
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      yield* webLinks.receive("https://example.com/first");
      yield* webLinks.receive("https://example.com/second");
      assert.deepStrictEqual(app.sent, []);

      yield* webLinks.setRendererReady(true, app.window);
      assert.deepStrictEqual(app.sent, ["https://example.com/first", "https://example.com/second"]);
      assert.strictEqual(revealed.length, 1);

      yield* webLinks.receive("https://example.com/third");
      assert.deepStrictEqual(app.sent.at(-1), "https://example.com/third");

      yield* webLinks.setRendererReady(false, app.window);
      yield* webLinks.receive("https://example.com/fourth");
      assert.strictEqual(app.sent.length, 3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("holds links that arrive while the web app reloads until it listens again", () => {
    const app = makeAppWindow();
    const { layer } = makeLayer([app]);
    return Effect.gen(function* () {
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      yield* webLinks.setRendererReady(true, app.window);
      app.reload();
      yield* webLinks.receive("https://example.com/during-reload");
      assert.deepStrictEqual(app.sent, []);

      yield* webLinks.setRendererReady(true, app.window);
      assert.deepStrictEqual(app.sent, ["https://example.com/during-reload"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("delivers to another ready window after the current one closes", () => {
    const first = makeAppWindow();
    const second = makeAppWindow();
    const loading = makeAppWindow();
    const { revealed, layer } = makeLayer([first, loading, second]);
    return Effect.gen(function* () {
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      yield* webLinks.setRendererReady(true, first.window);
      yield* webLinks.setRendererReady(true, second.window);
      yield* webLinks.receive("https://example.com/current");
      assert.deepStrictEqual(first.sent, ["https://example.com/current"]);

      first.close();
      yield* webLinks.receive("https://example.com/after-close");
      assert.deepStrictEqual(second.sent, ["https://example.com/after-close"]);
      assert.deepStrictEqual(loading.sent, []);
      assert.strictEqual(revealed.at(-1), second.window);
    }).pipe(Effect.provide(layer));
  });
});
