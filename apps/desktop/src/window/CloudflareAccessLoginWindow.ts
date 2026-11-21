import {
  CLOUDFLARE_ACCESS_APP_CALLBACK_URL,
  cloudflareAccessAppLoginUrl,
  cloudflareAccessLoginOrigin,
  readCloudflareAccessAppCallback,
} from "@t3tools/shared/cloudflareAccessLogin";
import * as Electron from "electron";

import { embeddedSignInUserAgent } from "./cloudflareAccessLoginUserAgent.ts";

// In memory, so a sign-in never outlives the app or mixes with the renderer's or previews' cookies.
const PARTITION = "cloudflare-access-login";

const isWebUrl = (url: string) => /^https?:/i.test(url);

let closeActive: (() => void) | null = null;

/**
 * Signs in through Cloudflare Access in a sandboxed window and returns the pairing credential the
 * server hands back on this build's app scheme, or null when the user closes the window. The
 * scheme redirect is caught here and never reaches the OS, so no other app can receive it.
 */
export const signInWithCloudflareAccess = (
  host: string,
  parent: Electron.BrowserWindow | null,
): Promise<string | null> => {
  const origin = cloudflareAccessLoginOrigin(host);
  if (origin === null) return Promise.reject(new Error("Sign-in needs an https address."));
  closeActive?.();

  return new Promise((resolve) => {
    const browserSession = Electron.session.fromPartition(PARTITION);
    browserSession.setUserAgent(embeddedSignInUserAgent(Electron.app.userAgentFallback));
    const webPreferences = {
      session: browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    } satisfies Electron.WebPreferences;
    const window = new Electron.BrowserWindow({
      width: 520,
      height: 720,
      ...(parent ? { parent } : {}),
      autoHideMenuBar: true,
      webPreferences,
    });
    let settled = false;
    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      if (closeActive === close) closeActive = null;
      resolve(token);
      if (!window.isDestroyed()) window.close();
    };
    const close = () => finish(null);
    closeActive = close;

    // Only web pages load here; the callback is read and every other scheme is dropped.
    const guard = (event: Electron.Event, url: string) => {
      if (isWebUrl(url)) return;
      event.preventDefault();
      // This build knows its own scheme, so only its exact callback counts.
      if (!url.startsWith(CLOUDFLARE_ACCESS_APP_CALLBACK_URL)) return;
      const token = readCloudflareAccessAppCallback(url);
      if (token !== null) finish(token);
    };
    const guardContents = (contents: Electron.WebContents) => {
      contents.on("will-navigate", guard);
      contents.on("will-redirect", guard);
      contents.on("will-frame-navigate", (event) => {
        if (!event.isMainFrame && !isWebUrl(event.url)) event.preventDefault();
      });
    };
    guardContents(window.webContents);
    // Identity providers may open popups; they stay in this session and under the same guard.
    window.webContents.setWindowOpenHandler(({ url }) =>
      isWebUrl(url)
        ? { action: "allow", overrideBrowserWindowOptions: { parent: window, webPreferences } }
        : { action: "deny" },
    );
    window.webContents.on("did-create-window", (popup) => guardContents(popup.webContents));
    window.on("closed", close);

    void window.loadURL(cloudflareAccessAppLoginUrl(origin)).catch(() => {
      // A load aborted by the callback redirect is expected; anything else leaves the page shown.
    });
  });
};
