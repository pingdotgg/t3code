import type { ToolActivityNativeAppReference } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import { existingFile, type NativeAppIconSource } from "./source.ts";

/** Sizes worth serving for a 64px icon, best first; the client scales down. */
const PREFERRED_SIZES = [64, 128, 96, 72, 256, 48, 512, 32] as const;
const ICON_EXTENSIONS = [".png", ".svg"] as const;
const MAX_DESKTOP_FILE_BYTES = 64 * 1024;

export interface DesktopEntry {
  readonly name: string;
  readonly icon: string;
  readonly wmClass: string | undefined;
  readonly fileStem: string;
}

/**
 * Reads the `[Desktop Entry]` group of a freedesktop launcher. Only the keys
 * the icon lookup needs are kept; localized `Name[xx]` variants are ignored
 * because agents see the unlocalized window class.
 */
export function parseDesktopEntry(contents: string, fileStem: string): DesktopEntry | undefined {
  let inEntry = false;
  let name: string | undefined;
  let icon: string | undefined;
  let wmClass: string | undefined;
  let hidden = false;
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inEntry || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "Name") name = value;
    else if (key === "Icon") icon = value;
    else if (key === "StartupWMClass") wmClass = value;
    else if ((key === "NoDisplay" || key === "Hidden") && value === "true") hidden = true;
  }
  if (hidden || !name || !icon) return undefined;
  return { name, icon, wmClass, fileStem };
}

const normalize = (value: string) => value.trim().toLocaleLowerCase();

/**
 * Window classes rarely match launcher names exactly: Chromium reports
 * `Chromium-browser` while its launcher is `chromium.desktop` named
 * "Chromium". Rank by the strictest match first so `StartupWMClass`, the key
 * launchers set for exactly this purpose, wins over a name that happens to
 * share a prefix.
 */
export function rankDesktopEntry(entry: DesktopEntry, app: ToolActivityNativeAppReference): number {
  const wanted = normalize(app._tag === "app-id" ? app.appId : app.displayName);
  const wmClass = entry.wmClass ? normalize(entry.wmClass) : undefined;
  const name = normalize(entry.name);
  const stem = normalize(entry.fileStem);
  if (wmClass === wanted) return 5;
  if (app._tag === "app-id" && stem === wanted) return 4;
  if (name === wanted || stem === wanted) return 3;
  if (wanted.startsWith(`${stem}-`) || wanted.startsWith(`${name}-`)) return 2;
  if (name.length >= 3 && wanted.startsWith(name)) return 1;
  return 0;
}

const applicationDirectories = Effect.fn("NativeAppIconResolver.linux.applicationDirectories")(
  function* () {
    const path = yield* Path.Path;
    const environment = yield* HostProcessEnvironment;
    const dataHome =
      environment.XDG_DATA_HOME?.trim() ||
      (environment.HOME ? path.join(environment.HOME, ".local", "share") : undefined);
    const dataDirs = (environment.XDG_DATA_DIRS?.trim() || "/usr/local/share:/usr/share")
      .split(":")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
    const roots = [...(dataHome ? [dataHome] : []), ...dataDirs];
    return {
      applications: roots.map((root) => path.join(root, "applications")),
      icons: roots.flatMap((root) => [
        path.join(root, "icons", "hicolor"),
        path.join(root, "pixmaps"),
      ]),
    };
  },
);

const readDesktopEntries = Effect.fn("NativeAppIconResolver.linux.readDesktopEntries")(function* (
  directories: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries: DesktopEntry[] = [];
  for (const directory of directories) {
    const fileNames = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): string[] => []));
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".desktop")) continue;
      const filePath = path.join(directory, fileName);
      const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
      if (info._tag === "None" || info.value.type !== "File") continue;
      if (info.value.size > MAX_DESKTOP_FILE_BYTES) continue;
      const contents = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
      if (contents._tag === "None") continue;
      const entry = parseDesktopEntry(contents.value, path.basename(fileName, ".desktop"));
      if (entry) entries.push(entry);
    }
  }
  return entries;
});

/**
 * `Icon=` is either an absolute path or a theme name looked up in hicolor by
 * size, then in pixmaps. A relative path with separators is rejected rather
 * than joined, since the entry could point anywhere.
 */
const resolveIconFile = Effect.fn("NativeAppIconResolver.linux.resolveIconFile")(function* (
  icon: string,
  iconDirectories: ReadonlyArray<string>,
) {
  const path = yield* Path.Path;
  if (path.isAbsolute(icon)) {
    const extension = path.extname(icon).toLowerCase();
    return (ICON_EXTENSIONS as ReadonlyArray<string>).includes(extension)
      ? yield* existingFile(icon)
      : null;
  }
  if (icon.includes("/") || icon.includes("\\") || icon.includes("..")) return null;
  const baseName = path.extname(icon) ? icon.slice(0, -path.extname(icon).length) : icon;
  for (const directory of iconDirectories) {
    const candidates = directory.endsWith("hicolor")
      ? [
          ...PREFERRED_SIZES.flatMap((size) =>
            ICON_EXTENSIONS.map((extension) =>
              path.join(directory, `${size}x${size}`, "apps", `${baseName}${extension}`),
            ),
          ),
          path.join(directory, "scalable", "apps", `${baseName}.svg`),
        ]
      : ICON_EXTENSIONS.map((extension) => path.join(directory, `${baseName}${extension}`));
    for (const candidate of candidates) {
      const found = yield* existingFile(candidate);
      if (found) return found;
    }
  }
  return null;
});

const resolveIcon = Effect.fn("NativeAppIconResolver.linux.resolve")(function* (
  app: ToolActivityNativeAppReference,
) {
  const directories = yield* applicationDirectories();
  const entries = yield* readDesktopEntries(directories.applications);
  let best: { readonly entry: DesktopEntry; readonly rank: number } | undefined;
  for (const entry of entries) {
    const rank = rankDesktopEntry(entry, app);
    if (rank > 0 && (!best || rank > best.rank)) best = { entry, rank };
  }
  if (!best) return null;
  return yield* resolveIconFile(best.entry.icon, directories.icons);
});

/**
 * Cua reports a Linux app by its X11 window class, with no bundle id. The
 * launcher database is the only place that maps a class back to an icon, so
 * `.desktop` entries are matched by class, name, or file name and their
 * `Icon=` resolved through the hicolor theme. PNG and SVG both serve as-is.
 */
export const linuxSource: NativeAppIconSource = {
  platform: "linux",
  resolve: resolveIcon,
};
