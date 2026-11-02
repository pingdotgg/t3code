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
