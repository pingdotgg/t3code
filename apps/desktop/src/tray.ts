import sharp from "sharp";
import {
  nativeImage,
  app,
  ipcMain,
  Tray,
  Menu,
  type MenuItemConstructorOptions,
  type BrowserWindow,
} from "electron";
import type { DesktopTrayState, DesktopTrayMessage, ThreadId } from "@t3tools/contracts";
import { getMainWindow } from "./main";

// Stolen from the T3Wordmark component in the web app
const T3_WORDMARK_VIEW_BOX = "15.5309 37 94.3941 56.96";
const T3_WORDMARK_PATH_STRING =
  "M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z";

const T3_TRAY_IMAGE_OPTICAL_Y_OFFSET_1X = 1.6; // vertically centering the wordmark looks weird, so we offset it slightly
const TRAY_SIZE_1X = 16;

/**
 * Rasterizes an SVG to a square template image.
 * @see: https://developer.apple.com/documentation/appkit/nsimage/istemplate
 * @param viewBox The viewBox of the SVG to rasterize
 * @param path The path of the SVG to rasterize
 * @param size The size of the resulting image
 * @param opticalYOffset The optical Y offset of the resulting image
 * @returns The resulting image as a PNG buffer
 */
async function rasterizeSvgToSquareTemplateImage(
  viewBox: string,
  path: string,
  size: number,
  opticalYOffset: number,
) {
  // Template images "should consist of only black and clear colors" (see above-linked documentation).
  const svg = `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg"><path d="${path}" fill="black" /></svg>`;
  return await sharp(Buffer.from(svg), {
    density: 2000,
  })
    .resize({
      width: size,
      height: size,
      fit: "contain",
      position: "centre",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .extend({
      top: opticalYOffset,
      bottom: 0,
      left: 0,
      right: 0,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .extract({ left: 0, top: 0, width: size, height: size })
    .png()
    .toBuffer();
}

async function createTrayTemplateImage() {
  const rasterizeT3Wordmark = async (size: number) => {
    const opticalYOffset = Math.max(
      0,
      Math.round((T3_TRAY_IMAGE_OPTICAL_Y_OFFSET_1X * size) / TRAY_SIZE_1X),
    );
    return await rasterizeSvgToSquareTemplateImage(
      T3_WORDMARK_VIEW_BOX,
      T3_WORDMARK_PATH_STRING,
      size,
      opticalYOffset,
    );
  };
  const image = nativeImage.createEmpty();
  const addRepresentation = async (scaleFactor: number, size: number) => {
    image.addRepresentation({
      scaleFactor: scaleFactor,
      width: size,
      height: size,
      buffer: await rasterizeT3Wordmark(size),
    });
  };
  await addRepresentation(1, TRAY_SIZE_1X);
  await addRepresentation(2, TRAY_SIZE_1X * 2);
  image.setTemplateImage(true);
  return image;
}

let tray: Tray | null = null;

async function createTray(): Promise<void> {
  // macOS only (for now)
  if (process.platform !== "darwin") tray = null;

  const image = await createTrayTemplateImage();
  const newTray = new Tray(image);
  newTray.setToolTip(app.getName());
  tray = newTray;
}

let trayState: DesktopTrayState = {
  threads: [],
};

// TODO: Maybe move this to a utils file?
function truncateGraphemes(value: string, maxLength: number): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemes = Array.from(segmenter.segment(value), (segment) => segment.segment);

  if (graphemes.length <= maxLength) {
    return value;
  }

  return `${graphemes.slice(0, maxLength).join("")}...`;
}

const MAX_THREAD_NAME_LENGTH = 20;
const MAX_THREADS_IN_CONTEXT_MENU = 3;
const MAX_VIEW_MORE_THREADS = 5;
function buildTrayContextMenu(): Menu {
  const sortedThreads = trayState.threads.sort((a, b) => b.lastUpdated - a.lastUpdated);
  const topLevelThreads = sortedThreads.slice(0, MAX_THREADS_IN_CONTEXT_MENU);
  const viewMoreThreads = sortedThreads.slice(
    MAX_THREADS_IN_CONTEXT_MENU,
    MAX_THREADS_IN_CONTEXT_MENU + MAX_VIEW_MORE_THREADS,
  );
  function buildThreadMenuItem(
    thread: DesktopTrayState["threads"][number],
  ): MenuItemConstructorOptions {
    return {
      // TODO: This isn't accessible to screen readers!
      label: `${thread.needsAttention ? "·" : ""} ${truncateGraphemes(thread.name, MAX_THREAD_NAME_LENGTH)}`,
      click: () => {
        const mainWindow = getMainWindow();
        if (!mainWindow) return;
        sendTrayMessage({ type: "thread-click", threadId: thread.id as ThreadId }, mainWindow);
        mainWindow.focus();
      },
    };
  }
  const menuItemConstructors: MenuItemConstructorOptions[] = [
    ...topLevelThreads.map(buildThreadMenuItem),
    {
      type: "submenu",
      label: `View More (${viewMoreThreads.length})`,
      submenu: viewMoreThreads.map(buildThreadMenuItem),
    },
  ];
  const menu = Menu.buildFromTemplate(menuItemConstructors);
  return menu;
}

function updateTray(): void {
  if (!tray) return;
  tray.setContextMenu(buildTrayContextMenu());
  const threadsNeedingAttention = trayState.threads.filter(
    (thread) => thread.needsAttention,
  ).length;
  if (threadsNeedingAttention > 0) {
    tray.setTitle(`(${threadsNeedingAttention} unread)`);
    // TODO: Do we want an icon variant as well?
  } else {
    tray.setTitle(""); // Clear the title
  }
}

async function getTrayState(): Promise<DesktopTrayState> {
  return trayState;
}

async function setTrayState(state: DesktopTrayState): Promise<void> {
  trayState = state;
  updateTray();
}

function setupTrayIpcHandlers(): void {
  const SET_TRAY_ENABLED_CHANNEL = "desktop:set-tray-enabled";
  ipcMain.handle(SET_TRAY_ENABLED_CHANNEL, async (_event, enabled: boolean) => {
    await setTrayEnabled(enabled);
  });
  const GET_TRAY_STATE_CHANNEL = "desktop:get-tray-state";
  ipcMain.handle(GET_TRAY_STATE_CHANNEL, async (_event) => {
    return await getTrayState();
  });
  const SET_TRAY_STATE_CHANNEL = "desktop:set-tray-state";
  ipcMain.handle(SET_TRAY_STATE_CHANNEL, async (_event, state: DesktopTrayState) => {
    await setTrayState(state);
  });
}

function sendTrayMessage(message: DesktopTrayMessage, window: BrowserWindow): void {
  const TRAY_MESSAGE_CHANNEL = "desktop:tray-message";
  window.webContents.send(TRAY_MESSAGE_CHANNEL, message);
}

async function configureTray(): Promise<void> {
  // TODO: Add a context menu to the tray
  await createTray();
}

async function setTrayEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    if (tray && !tray.isDestroyed()) return;
    await configureTray();
    updateTray();
  } else {
    if (tray?.isDestroyed() == false) tray.destroy();
    tray = null;
  }
}

export { setupTrayIpcHandlers, setTrayEnabled };
