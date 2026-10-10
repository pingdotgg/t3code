import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { WEB_LINK_OPEN_CHANNEL } from "../ipc/channels.ts";

/** An http(s) link the operating system handed to T3 Code as the default browser. */
export const isWebLink = (value: string) => {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
};

/** An HTML file the operating system asked T3 Code to open, as browsers are asked to. */
export const isWebPageFile = (path: string) => /\.x?html?$/i.test(path);

/**
 * Web links and HTML files macOS opens with T3 Code once it is the default
 * browser. Files arrive as file:// URLs. They can
 * arrive before the app is ready (the link that launched it) or while the web
 * app reloads, so they wait until the renderer says it is listening.
 */
export class DesktopWebLinks extends Context.Service<
  DesktopWebLinks,
  {
    /** Queues a link and delivers it as soon as the renderer is listening. */
    readonly receive: (url: string) => Effect.Effect<void>;
    /** The renderer started or stopped listening; listening flushes queued links. */
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopWebLinks") {}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const pending: Array<string> = [];
  /** The page that said it is listening; a reload or crash replaces it, and it must say so again. */
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
    // Links that arrive while a new page loads wait for it to listen again.
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
