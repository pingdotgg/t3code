import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { WEB_LINK_OPEN_CHANNEL } from "../ipc/channels.ts";
import { makeReadyAppRenderers } from "./readyAppRenderers.ts";

export const isWebLink = (value: string) => {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
};

export const isWebPageFile = (path: string) => /\.x?html?$/i.test(path);

export class DesktopWebLinks extends Context.Service<
  DesktopWebLinks,
  {
    readonly receive: (url: string) => Effect.Effect<void>;
    readonly setRendererReady: (
      ready: boolean,
      window: Electron.BrowserWindow,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopWebLinks") {}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const pending: Array<string> = [];
  const renderers = makeReadyAppRenderers();

  const flush = Effect.gen(function* () {
    if (pending.length === 0) return;
    const current = yield* electronWindow.currentAppWindow;
    const target = renderers.pick(current);
    if (target === undefined) return;
    for (const url of pending.splice(0)) target.webContents.send(WEB_LINK_OPEN_CHANNEL, url);
    if (Option.contains(current, target)) yield* desktopWindow.activate.pipe(Effect.ignore);
    else yield* electronWindow.reveal(target);
  });

  return DesktopWebLinks.of({
    receive: Effect.fn("DesktopWebLinks.receive")(function (url) {
      return Effect.suspend(() => {
        pending.push(url);
        return flush;
      });
    }),
    setRendererReady: Effect.fn("DesktopWebLinks.setRendererReady")(function (ready, window) {
      return Effect.sync(() => {
        if (ready) renderers.add(window);
        else renderers.drop(window.webContents);
      });
    }, Effect.andThen(flush)),
  });
});

export const layer = Layer.effect(DesktopWebLinks, make);
