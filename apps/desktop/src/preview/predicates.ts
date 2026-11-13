import type {
  PreviewInputSignal,
} from "./types.ts";

export const POPUP_PROTOCOLS = new Set(["http:", "https:"]);

// Main-process loadURL bypasses Chromium's renderer-side restrictions on local and inline URLs.

export const IN_PLACE_DENIED_PROTOCOLS = new Set([
  "about:",
  "chrome:",
  "data:",
  "devtools:",
  "file:",
  "filesystem:",
  "javascript:",
  "view-source:",
]);

/** Popups bypass will-attach-webview hardening and would inherit the picker's contextIsolation:false. */

export const POPUP_WINDOW_OPTIONS = {
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
} satisfies Electron.BrowserWindowConstructorOptions;

/**
 * OAuth needs a surviving popup opener. `blob:`, app links (behind the session's `openExternal`
 * prompt) and form POSTs stay in place.
 */

export const previewWindowOpenAction = (details: {
  readonly url: string;
  readonly disposition: Electron.HandlerDetails["disposition"];
  readonly postBody?: Electron.PostBody;
}): "popup" | "new-tab" | "navigate" | "deny" => {
  const protocol = URL.parse(details.url)?.protocol;
  // MSAL redirects on a denied blank popup; navigating the tab would destroy that fallback.
  if (protocol === undefined || IN_PLACE_DENIED_PROTOCOLS.has(protocol)) return "deny";
  if (!POPUP_PROTOCOLS.has(protocol)) return "navigate";
  if (details.disposition === "new-window") return "popup";
  return !details.postBody &&
    (details.disposition === "foreground-tab" || details.disposition === "background-tab")
    ? "new-tab"
    : "navigate";
};

export const isPreviewRefreshShortcut = (input: Electron.Input, platform: NodeJS.Platform): boolean =>
  input.type === "keyDown" &&
  input.key.toLowerCase() === "r" &&
  (platform === "darwin" ? input.meta && !input.control : input.control && !input.meta) &&
  !input.shift &&
  !input.alt;

export const isPreviewEditingShortcut = (
  input: Electron.Input,
  platform: NodeJS.Platform,
): boolean => {
  const isMac = platform === "darwin";
  if (isMac ? !input.meta || input.control : !input.control || input.meta) return false;

  const key = input.key.toLowerCase();
  // Option changes the DOM key for macOS Paste and Match Style (for example, to ◊).
  if (isMac && input.alt && input.shift && input.code === "KeyV") return true;
  if (key === "v" && input.shift) return input.alt === isMac;
  if (input.alt) return false;
  if (key === "z") return !input.shift || platform !== "win32";
  if (input.shift) return false;
  return (
    key === "a" ||
    key === "c" ||
    key === "v" ||
    key === "x" ||
    (key === "y" && platform === "win32")
  );
};

export const isPreviewInputSignal = (value: unknown): value is PreviewInputSignal => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "pointer") {
    return (
      "x" in value &&
      typeof value.x === "number" &&
      "y" in value &&
      typeof value.y === "number" &&
      "button" in value &&
      typeof value.button === "number"
    );
  }
  return (
    value.kind === "key" &&
    "key" in value &&
    typeof value.key === "string" &&
    "code" in value &&
    typeof value.code === "string"
  );
};
