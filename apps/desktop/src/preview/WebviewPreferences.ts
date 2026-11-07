/** sandbox:true is required with contextIsolation:false or the shared page global would expose Node and IPC. */
// Electron lacks the browser-owned FedCM dialog; use the sign-in popup fallback.
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=false,sandbox=true,nodeIntegration=false,disableBlinkFeatures=FedCm";
