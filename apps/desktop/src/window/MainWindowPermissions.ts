import * as Electron from "electron";

export type MediaPermissionDecision = "grant" | "deny" | "ask-microphone";

/** Whether `url` belongs to the app shell served from `appUrl` (e.g. `t3code://app/`). */
export function isAppUrl(url: string | undefined, appUrl: string): boolean {
  if (!url) return false;
  // Custom schemes have an opaque WHATWG origin, so compare the serialized prefix.
  const appOrigin = appUrl.endsWith("/") ? appUrl.slice(0, -1) : appUrl;
  return url === appOrigin || url.startsWith(`${appOrigin}/`);
}

/**
 * Media requests come from the app shell (voice conversations use the
 * microphone; preview tab recording routes `getDisplayMedia` through the same
 * permission). Frames from any other origin never get media. On macOS the
 * microphone also needs the system's consent, asked for on first use.
 */
export function decideMainWindowMediaRequest(input: {
  readonly requestingUrl: string;
  readonly appUrl: string;
  readonly mediaTypes: ReadonlyArray<"audio" | "video">;
  readonly platform: NodeJS.Platform;
  readonly microphoneStatus: () => string;
}): MediaPermissionDecision {
  if (!isAppUrl(input.requestingUrl, input.appUrl)) return "deny";
  if (!input.mediaTypes.includes("audio") || input.platform !== "darwin") return "grant";
  return input.microphoneStatus() === "granted" ? "grant" : "ask-microphone";
}

/**
 * Installs the main window session's permission handlers. Only `media` is
 * decided here; every other permission keeps Electron's default of allowing
 * it, which is what this session did before it had handlers.
 */
export function installMainWindowPermissionHandlers(
  session: Electron.Session,
  options: { readonly appUrl: string; readonly platform: NodeJS.Platform },
): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission !== "media") {
      callback(true);
      return;
    }
    const decision = decideMainWindowMediaRequest({
      requestingUrl: details.requestingUrl,
      appUrl: options.appUrl,
      mediaTypes: "mediaTypes" in details ? (details.mediaTypes ?? []) : [],
      platform: options.platform,
      microphoneStatus: () => Electron.systemPreferences.getMediaAccessStatus("microphone"),
    });
    if (decision !== "ask-microphone") {
      callback(decision === "grant");
      return;
    }
    Electron.systemPreferences.askForMediaAccess("microphone").then(callback, () => {
      callback(false);
    });
  });
  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    permission === "media" ? isAppUrl(requestingOrigin, options.appUrl) : true,
  );
}
