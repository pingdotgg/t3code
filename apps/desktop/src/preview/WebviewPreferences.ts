import { PASSKEY_BRIDGE_ARGUMENT, PRIMARY_PASTE_DISABLED_ARGUMENT } from "./GuestProtocol.ts";

/** The picker preload runs in its own JavaScript world; PageWorld.ts holds what must run in the page's. */
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=true,sandbox=true,nodeIntegration=false";

export const hardenPreviewWebviewPreferences = (
  webPreferences: Electron.WebPreferences,
  passkeyBridgeEnabled: boolean,
  primaryPasteEnabled: boolean,
): void => {
  webPreferences.sandbox = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.disableHtmlFullscreenWindowResize = true;
  if (passkeyBridgeEnabled) {
    webPreferences.additionalArguments = [
      ...(webPreferences.additionalArguments ?? []),
      PASSKEY_BRIDGE_ARGUMENT,
    ];
  }
  if (!primaryPasteEnabled) {
    webPreferences.additionalArguments = [
      ...(webPreferences.additionalArguments ?? []),
      PRIMARY_PASTE_DISABLED_ARGUMENT,
    ];
  }
};
