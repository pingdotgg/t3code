// @effect-diagnostics nodeBuiltinImport:off - resolves icon files on disk from the Electron main process, outside any Effect runtime.
/**
 * Runtime app icon.
 *
 * The installed bundle's icon cannot be rewritten without breaking the code
 * signature — and a broken signature takes every macOS permission grant with
 * it (see the TCC repair in computerUse/permissions). So the icon the user
 * picks is applied to the *running* app instead: the Dock tile on macOS, the
 * window icon elsewhere.
 *
 * @module appIcon/appIcon
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

/** Built-in icons, resolved from the assets shipped beside the app. */
const BUILT_IN_FILES: Readonly<Record<string, string>> = {
  default: "black-macos-1024.png",
  // A colour-inverted T3 tile: black mark on white.
  light: "light-macos-1024.png",
  // The T3 tile is already a white mark on black, which is what "Dark" means.
  dark: "black-macos-1024.png",
};

function iconSearchRoots(): readonly string[] {
  return [
    // Packaged: extraResources copies the assets to Resources/app-icons.
    NodePath.join(process.resourcesPath ?? "", "app-icons"),
    // Checkout: run straight from the repo's assets.
    NodePath.join(Electron.app.getAppPath(), "..", "..", "assets", "prod"),
    NodePath.join(Electron.app.getAppPath(), "..", "..", "assets", "munim"),
    NodePath.join(process.cwd(), "assets", "prod"),
    NodePath.join(process.cwd(), "assets", "munim"),
  ];
}

function resolveBuiltInIconPath(id: string): string | null {
  const file = BUILT_IN_FILES[id];
  if (file === undefined) return null;
  for (const root of iconSearchRoots()) {
    if (root.length === 0) continue;
    const candidate = NodePath.join(root, file);
    try {
      if (NodeFS.existsSync(candidate)) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/**
 * Apply an icon to the running app. `image` is a `data:` URL for a user's own
 * icon; otherwise `id` names a built-in. Returns whether anything was applied,
 * so a caller can leave the shipped icon alone rather than clearing it.
 */
export function applyAppIcon(input: {
  readonly id: string;
  readonly image?: string | undefined;
}): boolean {
  const icon =
    input.image !== undefined && input.image.startsWith("data:image/")
      ? Electron.nativeImage.createFromDataURL(input.image)
      : (() => {
          const path = resolveBuiltInIconPath(input.id);
          return path === null ? null : Electron.nativeImage.createFromPath(path);
        })();
  if (icon === null || icon.isEmpty()) return false;

  if (process.platform === "darwin") {
    try {
      Electron.app.dock?.setIcon(icon);
      return true;
    } catch {
      return false;
    }
  }

  let applied = false;
  for (const window of Electron.BrowserWindow.getAllWindows()) {
    try {
      window.setIcon(icon);
      applied = true;
    } catch {
      // A window that is closing cannot take an icon; the rest still can.
    }
  }
  return applied;
}
