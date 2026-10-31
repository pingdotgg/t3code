import * as Electron from "electron";

// Ask macOS for microphone consent before granting main-window capture; preserve other grants.
export function installMainWindowPermissions(
  webContents: Electron.WebContents,
  platform: NodeJS.Platform,
): void {
  webContents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
    const wantsMicrophone =
      platform === "darwin" &&
      permission === "media" &&
      requester === webContents &&
      "mediaTypes" in details &&
      details.mediaTypes?.includes("audio") === true;
    if (!wantsMicrophone) {
      callback(true);
      return;
    }
    void Electron.systemPreferences
      .askForMediaAccess("microphone")
      .then(callback, () => callback(false));
  });
}
