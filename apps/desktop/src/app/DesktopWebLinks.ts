import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import type { DesktopQuickComposerLaunch } from "@t3tools/contracts";

import { QUICK_COMPOSER_LAUNCH_CHANNEL, WEB_LINK_OPEN_CHANNEL } from "../ipc/channels.ts";

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
    /** Rides the same ready main renderer as links, so a launch during startup is not lost. */
    readonly receiveQuickComposerLaunch: (
      launch: DesktopQuickComposerLaunch,
    ) => Effect.Effect<void>;
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopWebLinks") {}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const pending: Array<readonly [channel: string, payload: unknown]> = [];
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
    for (const [channel, payload] of pending.splice(0)) listening.send(channel, payload);
    yield* desktopWindow.activate.pipe(Effect.ignore);
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
    receive: Effect.fn("DesktopWebLinks.receive")(function (url) {
      return Effect.suspend(() => {
        pending.push([WEB_LINK_OPEN_CHANNEL, url]);
        return flush;
      });
    }),
    receiveQuickComposerLaunch: Effect.fn("DesktopWebLinks.receiveQuickComposerLaunch")(
      function (launch) {
        return Effect.suspend(() => {
          pending.push([QUICK_COMPOSER_LAUNCH_CHANNEL, launch]);
          return flush;
        });
      },
    ),
    setRendererReady: Effect.fn("DesktopWebLinks.setRendererReady")(function (ready) {
      return ready ? startListening : Effect.sync(stopListening);
    }, Effect.andThen(flush)),
  });
});

export const layer = Layer.effect(DesktopWebLinks, make);
