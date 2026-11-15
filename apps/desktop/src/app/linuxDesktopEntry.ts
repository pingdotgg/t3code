const escapeDesktopEntryString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");

// Exec values undergo general unescaping then Exec unquoting; escape in reverse order.
export function escapeDesktopEntryExecArgument(value: string): string {
  const quoted = value
    .replaceAll("\\", () => "\\\\")
    .replaceAll("`", () => "\\`")
    .replaceAll("$", () => "\\$")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  return escapeDesktopEntryString(`"${quoted}"`);
}

// Legacy xdg-open looks up the first Exec word without unquoting it.
const escapeUrlHandlerExecTarget = (value: string): string =>
  /[ \t\n"'\\><~|&;$*?#()`]/.test(value)
    ? escapeDesktopEntryExecArgument(value)
    : escapeDesktopEntryString(value.replaceAll("%", "%%"));

// The AppImage integration entry owns the window identity. This
// hidden URL-only entry must not compete with it for StartupWMClass matching.
export function renderUrlHandlerDesktopEntry(input: {
  readonly displayName: string;
  readonly execTarget: string;
  readonly scheme: string;
  readonly iconPath?: string;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.displayName)}`,
    `Exec=${escapeUrlHandlerExecTarget(input.execTarget)} %U`,
    ...(input.iconPath === undefined ? [] : [`Icon=${escapeDesktopEntryString(input.iconPath)}`]),
    "Terminal=false",
    "NoDisplay=true",
    "StartupNotify=false",
    `MimeType=x-scheme-handler/${input.scheme};`,
    "",
  ].join("\n");
}

function parseUrlHandlerExecTarget(entry: string): string | null {
  const exec = /^Exec=(.*) %U$/mu.exec(entry)?.[1];
  if (exec === undefined) return null;
  const unescaped = exec.replace(/\\([\\nrt])/gu, (_, char: string) =>
    char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t" : char,
  );
  const quoted = /^"(.*)"$/su.exec(unescaped)?.[1];
  return (
    quoted === undefined ? unescaped : quoted.replace(/\\([\\`$"])/gu, (_, char: string) => char)
  ).replaceAll("%%", "%");
}

const APPIMAGE_NAME_VERSION = /\d+\.\d+\.\d+/u;

// An updater from before version-free AppImage names deletes its own file and installs the update
// beside it under the new name. The previous launch's entry still names the path launchers use.
export function replacedVersionedAppImagePath(input: {
  readonly previousEntry: string;
  readonly appImagePath: string;
}): string | null {
  const previous = parseUrlHandlerExecTarget(input.previousEntry);
  if (previous === null) return null;
  const previousName = previous.slice(previous.lastIndexOf("/") + 1);
  const currentName = input.appImagePath.slice(input.appImagePath.lastIndexOf("/") + 1);
  return previous.startsWith("/") &&
    previous.slice(0, -previousName.length) === input.appImagePath.slice(0, -currentName.length) &&
    APPIMAGE_NAME_VERSION.test(previousName) &&
    !APPIMAGE_NAME_VERSION.test(currentName)
    ? previous
    : null;
}
