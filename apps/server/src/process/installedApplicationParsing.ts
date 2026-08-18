/**
 * Pure parsing helpers for installed-application discovery.
 *
 * Kept free of Effect and the filesystem so each platform's entry format can
 * be tested against real-world samples without a host to scan.
 *
 * @module installedApplicationParsing
 */
import type { InstalledApplication } from "@t3tools/contracts";

/**
 * Freedesktop field codes (`%f`, `%U`, ...). They stand in for the files the
 * launcher would substitute; we pass the project path ourselves, so every code
 * is dropped rather than forwarded as a literal argument.
 */
const DESKTOP_ENTRY_FIELD_CODE = /^%[fFuUdDnNickvm]$/;

/**
 * Splits an `Exec=` value the way the desktop-entry spec does: whitespace
 * separates arguments, and quoted runs keep their spaces. Backslash escapes
 * inside quotes are unwrapped.
 */
export function parseExecArguments(exec: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasCurrent = false;

  for (let index = 0; index < exec.length; index += 1) {
    const char = exec[index]!;

    if (quote !== null && char === "\\" && index + 1 < exec.length) {
      const next = exec[index + 1]!;
      // Only these are escapes inside a quoted desktop-entry string; anything
      // else keeps the backslash so Windows-style paths survive.
      if (next === quote || next === "\\") {
        current += next;
        index += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasCurrent = true;
      continue;
    }

    if (char === " " || char === "\t") {
      if (hasCurrent || current.length > 0) {
        tokens.push(current);
        current = "";
        hasCurrent = false;
      }
      continue;
    }

    current += char;
  }

  if (hasCurrent || current.length > 0) {
    tokens.push(current);
  }

  return tokens.filter((token) => !DESKTOP_ENTRY_FIELD_CODE.test(token));
}

interface DesktopEntryFields {
  readonly name?: string;
  readonly exec?: string;
  readonly type?: string;
  readonly noDisplay?: string;
  readonly hidden?: string;
  readonly terminal?: string;
}

/**
 * Reads the `[Desktop Entry]` group only. Later groups (`[Desktop Action ...]`)
 * describe secondary launcher actions and must not override the main entry.
 */
function readDesktopEntryGroup(contents: string): DesktopEntryFields {
  const fields: Record<string, string> = {};
  let inEntryGroup = false;

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    if (line.startsWith("[")) {
      inEntryGroup = line === "[Desktop Entry]";
      continue;
    }
    if (!inEntryGroup) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    // Skip localized keys (`Name[de]`); the unlocalized one is the fallback.
    if (key.includes("[")) continue;
    if (key in fields) continue;
    fields[key] = line.slice(separator + 1).trim();
  }

  return {
    ...(fields.Name === undefined ? {} : { name: fields.Name }),
    ...(fields.Exec === undefined ? {} : { exec: fields.Exec }),
    ...(fields.Type === undefined ? {} : { type: fields.Type }),
    ...(fields.NoDisplay === undefined ? {} : { noDisplay: fields.NoDisplay }),
    ...(fields.Hidden === undefined ? {} : { hidden: fields.Hidden }),
    ...(fields.Terminal === undefined ? {} : { terminal: fields.Terminal }),
  };
}

/**
 * Turns one `.desktop` file into an application entry, or null when it is not
 * a launchable, user-visible application (a link, a hidden entry, a terminal
 * program with no GUI, or a malformed file).
 */
export function parseDesktopEntry(contents: string): Omit<InstalledApplication, "id"> | null {
  const fields = readDesktopEntryGroup(contents);

  if (fields.type !== undefined && fields.type !== "Application") return null;
  if (fields.noDisplay === "true" || fields.hidden === "true") return null;
  // A terminal program opens a console, not a window onto the project.
  if (fields.terminal === "true") return null;
  if (fields.name === undefined || fields.exec === undefined) return null;

  const name = fields.name.trim();
  const [command, ...args] = parseExecArguments(fields.exec);
  if (name.length === 0 || command === undefined || command.length === 0) return null;

  return { name, command, args };
}

/** Application name for a macOS bundle directory, e.g. `Sublime Text.app`. */
export function parseMacApplicationBundleName(bundleFileName: string): string | null {
  if (!bundleFileName.endsWith(".app")) return null;
  const name = bundleFileName.slice(0, -".app".length).trim();
  return name.length === 0 ? null : name;
}

/** Application name for a Windows Start Menu shortcut, e.g. `Notepad++.lnk`. */
export function parseWindowsShortcutName(shortcutFileName: string): string | null {
  const lower = shortcutFileName.toLowerCase();
  if (!lower.endsWith(".lnk")) return null;
  const name = shortcutFileName.slice(0, -".lnk".length).trim();
  // Uninstallers and help links are noise in an "open this project" list.
  if (name.length === 0 || /^(uninstall|readme|help|website|documentation)\b/i.test(name)) {
    return null;
  }
  return name;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

/**
 * Assigns stable, unique ids and sorts by display name. Two applications can
 * legitimately share a name (same app in `/usr/share` and `~/.local/share`),
 * so the first wins and later duplicates are dropped rather than suffixed -
 * the list is a menu, not an inventory.
 */
export function finalizeInstalledApplications(
  entries: ReadonlyArray<Omit<InstalledApplication, "id">>,
): ReadonlyArray<InstalledApplication> {
  const byId = new Map<string, InstalledApplication>();

  for (const entry of entries) {
    const id = slugify(entry.name);
    if (id.length === 0 || byId.has(id)) continue;
    byId.set(id, { id, name: entry.name, command: entry.command, args: entry.args });
  }

  return [...byId.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}
