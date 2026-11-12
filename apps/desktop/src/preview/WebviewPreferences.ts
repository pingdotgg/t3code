import { PASSKEY_BRIDGE_ARGUMENT, PRIMARY_PASTE_DISABLED_ARGUMENT } from "./GuestProtocol.ts";

/** sandbox:true is required with contextIsolation:false or the shared page global would expose Node and IPC. */
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=false,sandbox=true,nodeIntegration=false";

export const hardenPreviewWebviewPreferences = (
  webPreferences: Electron.WebPreferences,
  passkeyBridgeEnabled: boolean,
  primaryPasteEnabled: boolean,
): void => {
  webPreferences.sandbox = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = false;
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
