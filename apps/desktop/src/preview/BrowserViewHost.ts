import { BrowserWindow, View, WebContentsView, type Session } from "electron";

import type { DesktopBrowserLayout, DesktopBrowserInput } from "@t3tools/contracts";
import { BROWSER_CURSOR_CHANNEL } from "../ipc/channels.ts";

interface BrowserViewEntry {
  readonly view: WebContentsView;
  readonly container: View;
  layout: DesktopBrowserLayout;
  zoomFactor: number;
  interactive: boolean;
}

/**
 * Standalone pages have independent frame focus. Keep passive views in a
 * nonfocusable window because BrowserWindow.contentView always paints above
 * the app renderer. Human input moves the same page into the app window.
 */
export class BrowserViewHost {
  readonly #mainWindow: BrowserWindow;
  readonly #window: BrowserWindow;
  readonly #mainContents: Electron.WebContents;
  readonly #configureContents: ((contents: Electron.WebContents) => void) | undefined;
  readonly #tabs = new Map<string, BrowserViewEntry>();

  constructor(
    mainWindow: BrowserWindow,
    platform: NodeJS.Platform,
    configureContents?: (contents: Electron.WebContents) => void,
  ) {
    this.#mainContents = mainWindow.webContents;
    this.#configureContents = configureContents;
    this.#mainWindow = mainWindow;
    this.#window = new BrowserWindow({
      x: 0,
      y: 0,
      frame: false,
      width: 1280,
      height: 800,
      title: "T3 browser automation host",
      show: false,
      focusable: false,
      opacity: 0,
      skipTaskbar: true,
      webPreferences: { sandbox: true, backgroundThrottling: false },
    });
    // X11 without a compositor ignores opacity. An empty shape keeps the host
    // invisible there without hiding its WebContents or suspending capture.
    if (platform === "linux") this.#window.setShape([{ x: 0, y: 0, width: 0, height: 0 }]);
    this.#window.setIgnoreMouseEvents(true);
    this.#window.showInactive();
    mainWindow.webContents.on("focus", this.#parkAll);
    mainWindow.on("blur", this.#parkAll);
    mainWindow.once("closed", this.destroy);
  }

  create(tabId: string, session: Session, preload: string, zoomFactor: number) {
    const existing = this.#tabs.get(tabId);
    if (existing && !existing.view.webContents.isDestroyed()) return existing.view.webContents;
    this.close(tabId);
    const view = new WebContentsView({
      webPreferences: {
        session,
        preload,
        sandbox: true,
        contextIsolation: false,
        nodeIntegration: false,
        backgroundThrottling: false,
        focusOnNavigation: false,
      },
    });
    const entry: BrowserViewEntry = {
      view,
      container: new View(),
      layout: {
        rendering: false,
        viewport: { width: 1280, height: 800 },
        clip: null,
        content: { x: 0, y: 0, scale: 1 },
      },
      zoomFactor,
      interactive: false,
    };
    entry.container.addChildView(view);
    this.#window.contentView.addChildView(entry.container);
    this.#tabs.set(tabId, entry);
    this.#configureContents?.(view.webContents);
    view.webContents.on("cursor-changed", (_event, type, image, scale, _size, hotspot) => {
      if (this.#mainContents.isDestroyed()) return;
      const cursor =
        type === "custom" && !image.isEmpty()
          ? `url(${image.toDataURL()}) ${Math.round(hotspot.x / scale)} ${Math.round(hotspot.y / scale)}, auto`
          : type === "hand"
            ? "pointer"
            : type === "pointer"
              ? "default"
              : type === "nodrop"
                ? "no-drop"
                : type;
      this.#mainContents.send(BROWSER_CURSOR_CHANNEL, tabId, cursor);
    });
    this.#applyLayout(entry);
    return view.webContents;
  }

  owns(tabId: string, contents: Electron.WebContents) {
    return this.#tabs.get(tabId)?.view.webContents === contents;
  }

  isInteractive(tabId: string) {
    return this.#tabs.get(tabId)?.interactive ?? false;
  }

  layout(tabId: string, layout: DesktopBrowserLayout) {
    const entry = this.#tabs.get(tabId);
    if (!entry) return;
    entry.layout = layout;
    if (!layout.clip) this.park(tabId);
    this.#applyLayout(entry);
  }

  setZoomFactor(tabId: string, zoomFactor: number) {
    const entry = this.#tabs.get(tabId);
    if (!entry) return;
    entry.zoomFactor = zoomFactor;
    this.#applyLayout(entry);
  }

  input(tabId: string, input: DesktopBrowserInput | null) {
    const entry = this.#tabs.get(tabId);
    if (!entry || entry.view.webContents.isDestroyed()) return;
    if (input === null || input.type === "mouseDown") {
      if (!entry.layout.clip) return;
      if (!entry.interactive) {
        this.#parkAll();
        this.#window.contentView.removeChildView(entry.container);
        this.#mainWindow.contentView.addChildView(entry.container);
        entry.interactive = true;
        this.#applyLayout(entry);
        entry.view.webContents.focus();
      }
    }
    if (!input || (input.type === "mouseUp" && !entry.interactive)) return;
    const zoom = this.#mainContents.getZoomFactor();
    entry.view.webContents.sendInputEvent({
      ...input,
      x: input.x * zoom,
      y: input.y * zoom,
      ...(input.type === "mouseWheel"
        ? { deltaX: input.deltaX * zoom, deltaY: input.deltaY * zoom }
        : {}),
      modifiers: [...input.modifiers],
    });
  }

  park(tabId: string) {
    const entry = this.#tabs.get(tabId);
    if (!entry?.interactive) return;
    const focused = !entry.view.webContents.isDestroyed() && entry.view.webContents.isFocused();
    if (!this.#mainWindow.isDestroyed())
      this.#mainWindow.contentView.removeChildView(entry.container);
    if (!this.#window.isDestroyed()) this.#window.contentView.addChildView(entry.container);
    entry.interactive = false;
    this.#applyLayout(entry);
    if (focused && !this.#mainWindow.isDestroyed() && this.#mainWindow.isFocused())
      this.#mainWindow.webContents.focus();
  }

  close(tabId: string) {
    const entry = this.#tabs.get(tabId);
    if (!entry) return;
    this.park(tabId);
    this.#tabs.delete(tabId);
    if (!this.#window.isDestroyed()) this.#window.contentView.removeChildView(entry.container);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  }

  readonly destroy = () => {
    this.#mainContents.removeListener("focus", this.#parkAll);
    this.#mainWindow.removeListener("blur", this.#parkAll);
    this.#mainWindow.removeListener("closed", this.destroy);
    for (const tabId of this.#tabs.keys()) this.close(tabId);
    if (!this.#window.isDestroyed()) this.#window.destroy();
  };

  readonly #parkAll = () => {
    for (const tabId of this.#tabs.keys()) this.park(tabId);
  };

  #applyLayout(entry: BrowserViewEntry) {
    if (entry.view.webContents.isDestroyed()) return;
    const { viewport, clip, content } = entry.layout;
    const appZoom = this.#mainContents.isDestroyed() ? 1 : this.#mainContents.getZoomFactor();
    // Preserve the presented scale across handoff. Changing zoom at mouse-down
    // races Chromium's input-coordinate update and can hit the wrong element.
    const scale = clip ? content.scale * appZoom : 1;
    // Keep the native view attached and visible: Chromium drops injected clicks
    // when its View is hidden. The transparent, nonfocusable host stays on-screen
    // because Chromium suspends display-media frames for fully offscreen windows.
    entry.view.webContents.setBackgroundThrottling(!entry.interactive && !entry.layout.rendering);
    const width = Math.max(1, Math.round(viewport.width * entry.zoomFactor * scale));
    const height = Math.max(1, Math.round(viewport.height * entry.zoomFactor * scale));
    entry.container.setBounds(
      entry.interactive && clip
        ? {
            x: Math.round(clip.x * appZoom),
            y: Math.round(clip.y * appZoom),
            width: Math.round(clip.width * appZoom),
            height: Math.round(clip.height * appZoom),
          }
        : { x: 0, y: 0, width, height },
    );
    entry.view.setBounds({
      x: entry.interactive ? Math.round(content.x * appZoom) : 0,
      y: entry.interactive ? Math.round(content.y * appZoom) : 0,
      width,
      height,
    });
    entry.view.webContents.setZoomFactor(entry.zoomFactor * scale);
    const sizes = Array.from(this.#tabs.values())
      .filter((tab) => !tab.interactive)
      .map((tab) => ({
        width: Math.round(tab.layout.viewport.width * tab.zoomFactor),
        height: Math.round(tab.layout.viewport.height * tab.zoomFactor),
      }));
    const parkedWidth = Math.max(1, ...sizes.map((size) => size.width));
    const parkedHeight = Math.max(1, ...sizes.map((size) => size.height));
    if (this.#window.isDestroyed()) return;
    const [currentWidth, currentHeight] = this.#window.getContentSize();
    if (currentWidth !== parkedWidth || currentHeight !== parkedHeight)
      this.#window.setContentSize(parkedWidth, parkedHeight);
  }
}
