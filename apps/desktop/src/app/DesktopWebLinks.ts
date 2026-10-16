import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { WEB_LINK_OPEN_CHANNEL } from "../ipc/channels.ts";

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
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopWebLinks") {}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const pending: Array<string> = [];
  let listening: Electron.WebContents | null = null;
  let detachListening: (() => void) | null = null;

  const stopListening = () => {
    detachListening?.();
    detachListening = null;
    listening = null;
  };

  const flush = Effect.gen(function* () {
    if (listening === null || pending.length === 0) return;
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window) || window.value.webContents !== listening) return;
    if (listening.isDestroyed()) {
      stopListening();
      return;
    }
    for (const url of pending.splice(0)) listening.send(WEB_LINK_OPEN_CHANNEL, url);
    yield* electronWindow.reveal(window.value);
  });

  const startListening = Effect.gen(function* () {
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window) || window.value.webContents.isDestroyed()) return;
    const webContents = window.value.webContents;
    if (listening === webContents) return;
    stopListening();
    listening = webContents;
    const onNavigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) stopListening();
    };
    webContents.on("did-start-navigation", onNavigation);
    webContents.on("render-process-gone", stopListening);
    webContents.once("destroyed", stopListening);
    detachListening = () => {
      webContents.removeListener("did-start-navigation", onNavigation);
      webContents.removeListener("render-process-gone", stopListening);
      webContents.removeListener("destroyed", stopListening);
    };
  });

  return DesktopWebLinks.of({
    receive: (url) =>
      Effect.suspend(() => {
        pending.push(url);
        return flush;
      }).pipe(Effect.withSpan("DesktopWebLinks.receive")),
    setRendererReady: (ready) =>
      (ready ? startListening : Effect.sync(stopListening)).pipe(
        Effect.andThen(flush),
        Effect.withSpan("DesktopWebLinks.setRendererReady"),
      ),
  });
});

export const layer = Layer.effect(DesktopWebLinks, make);
