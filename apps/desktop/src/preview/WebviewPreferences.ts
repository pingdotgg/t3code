/** sandbox:true is required with contextIsolation:false or the shared page global would expose Node and IPC. */
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=false,sandbox=true,nodeIntegration=false";
