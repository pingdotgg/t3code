/**
 * - `sandbox=true`: keeps the OS-level renderer sandbox enabled. Critical
 *   when paired with `contextIsolation=false` — without sandbox, the preload
 *   has full Node access (`require`, `fs`, `child_process`, ...) and that
 *   `require` would land on the page's shared `globalThis`, giving any
 *   third-party page in the preview full Node + IPC access to the host.
 */
// Electron lacks the browser-owned FedCM dialog; let preview sign-in use its popup fallback.
export const PREVIEW_WEBVIEW_PREFERENCES =
  "contextIsolation=false,sandbox=true,nodeIntegration=false,disableBlinkFeatures=FedCm";
