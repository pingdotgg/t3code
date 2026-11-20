import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { BrowserWindow, ipcMain, type IpcMainEvent, session, WebContentsView } from "electron";

import { normalizeUrl } from "../src/browser/tabs";
import type { BrowserTabState } from "../src/connection/engineState";

// A separate persistent session keeps the user's logins out of the app's own page and lets them survive a restart.
const PARTITION = "persist:agent-board-browser";
const BACKGROUND_COLOR = "#151618";

const TabId = Schema.NonEmptyString;
const Bounds = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});
const decodeOpen = Schema.decodeUnknownOption(Schema.Tuple([TabId, Schema.String]));
const decodeId = Schema.decodeUnknownOption(Schema.Tuple([TabId]));
const decodeOptionalId = Schema.decodeUnknownOption(Schema.Tuple([Schema.NullOr(TabId)]));
const decodeNavigate = Schema.decodeUnknownOption(Schema.Tuple([TabId, Schema.String]));
const decodeHistory = Schema.decodeUnknownOption(Schema.Tuple([TabId, Schema.Literals([-1, 1])]));
const decodeBounds = Schema.decodeUnknownOption(Schema.Tuple([Schema.NullOr(Bounds)]));

type Rect = typeof Bounds.Type;

const rounded = ({ x, y, width, height }: Rect): Rect => ({
  x: Math.round(x),
  y: Math.round(y),
  width: Math.round(width),
  height: Math.round(height),
});

/**
 * Hosts the user's tabs as native pages over the window. The renderer owns the tab list and the
 * rectangle the active page fills, and the main process owns the pages.
 */
export function registerBrowserViews(): void {
  const views = new Map<string, WebContentsView>();
  const windows = new WeakSet<BrowserWindow>();
  let activeId: string | null = null;
  let bounds: Rect | null = null;

  session
    .fromPartition(PARTITION)
    .setPermissionRequestHandler((_contents, _permission, answer) => answer(false));

  const closeAll = (window: BrowserWindow) => {
    for (const view of views.values()) {
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    views.clear();
    activeId = null;
    bounds = null;
  };

  const layout = () => {
    for (const [id, view] of views) {
      if (id === activeId && bounds !== null) {
        view.setBounds(bounds);
        view.setVisible(true);
      } else {
        view.setVisible(false);
      }
    }
  };

  const open = (event: IpcMainEvent, id: string, url: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null || views.has(id)) return;
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true },
    });
    view.setBackgroundColor(BACKGROUND_COLOR);
    view.setVisible(false);
    const { webContents } = view;
    const report = () => {
      if (webContents.isDestroyed() || event.sender.isDestroyed()) return;
      const state: BrowserTabState = {
        id,
        url: webContents.getURL(),
        title: webContents.getTitle(),
        loading: webContents.isLoading(),
        canGoBack: webContents.navigationHistory.canGoBack(),
        canGoForward: webContents.navigationHistory.canGoForward(),
      };
      event.sender.send("board:browser-tab", state);
    };
    webContents.on("did-navigate", report);
    webContents.on("did-navigate-in-page", report);
    webContents.on("page-title-updated", report);
    webContents.on("did-start-loading", report);
    webContents.on("did-stop-loading", report);
    // A rejected load is the page's own error screen, which the page shows already.
    const load = (target: string) => void webContents.loadURL(target).catch(() => undefined);
    webContents.setWindowOpenHandler(({ url: target }) => {
      if (normalizeUrl(target) !== null) load(target);
      return { action: "deny" };
    });
    webContents.on("will-navigate", (navigation, target) => {
      if (normalizeUrl(target) === null) navigation.preventDefault();
    });
    window.contentView.addChildView(view);
    views.set(id, view);
    if (!windows.has(window)) {
      windows.add(window);
      // The tab list lives in the renderer, so a reload leaves these pages with no tab to show them.
      event.sender.on("did-start-navigation", (navigation) => {
        if (navigation.isMainFrame && !navigation.isSameDocument) closeAll(window);
      });
      window.once("closed", () => closeAll(window));
    }
    if (url !== "") load(url);
    layout();
  };

  const withView = (id: string, use: (view: WebContentsView) => void) => {
    const view = views.get(id);
    if (view !== undefined && !view.webContents.isDestroyed()) use(view);
  };

  ipcMain.on("board:browser-open", (event, ...args) => {
    Option.map(decodeOpen(args), ([id, url]) => {
      const target = url === "" ? "" : normalizeUrl(url);
      if (target !== null) open(event, id, target);
    });
  });
  ipcMain.on("board:browser-close", (event, ...args) => {
    Option.map(decodeId(args), ([id]) =>
      withView(id, (view) => {
        BrowserWindow.fromWebContents(event.sender)?.contentView.removeChildView(view);
        views.delete(id);
        view.webContents.close();
      }),
    );
  });
  ipcMain.on("board:browser-activate", (_event, ...args) => {
    Option.map(decodeOptionalId(args), ([id]) => {
      activeId = id;
      layout();
    });
  });
  ipcMain.on("board:browser-navigate", (_event, ...args) => {
    Option.map(decodeNavigate(args), ([id, url]) => {
      const target = normalizeUrl(url);
      if (target === null) return;
      withView(id, (view) => void view.webContents.loadURL(target).catch(() => undefined));
    });
  });
  ipcMain.on("board:browser-history", (_event, ...args) => {
    Option.map(decodeHistory(args), ([id, delta]) =>
      withView(id, ({ webContents }) => {
        if (delta === -1) webContents.navigationHistory.goBack();
        else webContents.navigationHistory.goForward();
      }),
    );
  });
  ipcMain.on("board:browser-reload", (_event, ...args) => {
    Option.map(decodeId(args), ([id]) => withView(id, ({ webContents }) => webContents.reload()));
  });
  ipcMain.on("board:browser-bounds", (_event, ...args) => {
    Option.map(decodeBounds(args), ([next]) => {
      bounds = next === null ? null : rounded(next);
      layout();
    });
  });
}
