import * as Option from "effect/Option";
import type * as Electron from "electron";

/** App windows whose renderer said it is ready, each dropped once it navigates, crashes or closes. */
export function makeReadyAppRenderers(onDropped?: (webContents: Electron.WebContents) => void) {
  const ready = new Map<
    Electron.WebContents,
    { readonly window: Electron.BrowserWindow; readonly detach: () => void }
  >();

  const drop = (webContents: Electron.WebContents) => {
    const entry = ready.get(webContents);
    if (entry === undefined) return;
    ready.delete(webContents);
    entry.detach();
    onDropped?.(webContents);
  };

  const add = (window: Electron.BrowserWindow) => {
    const webContents = window.webContents;
    if (ready.has(webContents) || webContents.isDestroyed()) return;
    const onNavigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) drop(webContents);
    };
    const onGone = () => drop(webContents);
    webContents.on("did-start-navigation", onNavigation);
    webContents.on("render-process-gone", onGone);
    webContents.once("destroyed", onGone);
    ready.set(webContents, {
      window,
      detach: () => {
        webContents.removeListener("did-start-navigation", onNavigation);
        webContents.removeListener("render-process-gone", onGone);
        webContents.removeListener("destroyed", onGone);
      },
    });
  };

  /** The current app window when its renderer is ready, else any ready one. */
  const pick = (current: Option.Option<Electron.BrowserWindow>) => {
    const preferred = Option.getOrUndefined(current);
    const live = Array.from(ready.values()).filter(({ window }) => !window.isDestroyed());
    return (live.find(({ window }) => window === preferred) ?? live[0])?.window;
  };

  return {
    add,
    drop,
    pick,
    get size() {
      return ready.size;
    },
  };
}
