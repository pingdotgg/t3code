/**
 * Pure parsing helpers for installed-application discovery.
 *
 * Kept free of Effect and the filesystem so each platform's entry format can
 * be tested against real-world samples without a host to scan.
 *
 * @module installedApplicationParsing
 */
import {
  CUSTOM_EDITOR_ID_PREFIX,
  type CustomEditor,
  type CustomEditorId,
  type InstalledApplication,
} from "@t3tools/contracts";

/**
 * Freedesktop field codes (`%f`, `%U`, ...) stand in for the files the launcher
 * would substitute. Only the file/URL codes mark where the project path goes;
 * the rest (icon, name, deprecated codes) carry no argument and are dropped.
 */
const DESKTOP_ENTRY_PATH_FIELD_CODE = /^%[fFuU]$/;
const DESKTOP_ENTRY_OTHER_FIELD_CODE = /^%[dDnNickvm]$/;

/**
 * Marks where the project path belongs in an application's argument list.
 * `Exec=editor %F --new-window` must launch as `editor <path> --new-window`,
 * so the placeholder position is preserved rather than the path being appended.
 */
export const PROJECT_PATH_PLACEHOLDER = "\u0000t3-project-path";

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

  // Collapse every file/URL code to a single placeholder: an entry may list
  // more than one, but a project opens in exactly one location.
  let placed = false;
  const result: string[] = [];
  for (const token of tokens) {
    if (DESKTOP_ENTRY_OTHER_FIELD_CODE.test(token)) continue;
    if (DESKTOP_ENTRY_PATH_FIELD_CODE.test(token)) {
      if (placed) continue;
      placed = true;
      result.push(PROJECT_PATH_PLACEHOLDER);
      continue;
    }
    result.push(token);
  }
  return result;
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

/**
 * Readable ASCII prefix for an application id.
 *
 * Deliberately ASCII: the id ends up in `CustomEditorId`, whose schema accepts
 * only `[0-9a-z-]`. A name in another script simply yields an empty prefix and
 * leans on the hash below rather than producing an id the schema rejects.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

/**
 * FNV-1a over the exact name. Short, stable, and dependency-free; it only has
 * to separate a few hundred application names, not resist collisions.
 */
function nameDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.codePointAt(index)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Id for a discovered application, derived from its name alone.
 *
 * The digest is not decoration. Ids are persisted when a user remembers an
 * application, so they must not depend on what else happens to be installed:
 * numbering collisions positionally would let a later install of a
 * similarly-named program take an id an existing entry already owns, pointing
 * a remembered application at a different binary. Deriving the whole id from
 * the name keeps it fixed for the life of that application.
 */
export function applicationIdForName(name: string): string {
  const slug = slugify(name);
  const digest = nameDigest(name);
  return slug.length === 0 ? digest : `${slug}-${digest}`;
}

/**
 * Assigns ids and sorts by display name.
 *
 * The same application really can appear twice (in `/usr/share` and again in
 * `~/.local/share`); those exact-name duplicates collapse to one entry, scan
 * order deciding the winner so a user's own override beats the system copy.
 * Two *different* names stay distinct even when their readable prefixes match
 * ("Code - OSS" and "Code OSS"), because the id carries a digest of the name.
 */
export function finalizeInstalledApplications(
  entries: ReadonlyArray<Omit<InstalledApplication, "id">>,
): ReadonlyArray<InstalledApplication> {
  // Collapse exact-name duplicates in scan order, so the caller's directory
  // precedence decides the winner (a user's ~/.local/share override beats the
  // system copy of the same application).
  const byName = new Map<string, Omit<InstalledApplication, "id">>();
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }

  const sorted = [...byName.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );

  return sorted.map((entry) => ({
    id: applicationIdForName(entry.name),
    name: entry.name,
    command: entry.command,
    args: entry.args,
  }));
}

/**
 * Resolves an application's stored arguments against a project path.
 *
 * The path replaces the placeholder captured from the application's own entry,
 * so `editor %F --new-window` runs as `editor <path> --new-window`. Entries
 * with no placeholder (a macOS bundle, a Windows shortcut, an `Exec` that
 * names no file code) take the path appended, which is how a command that
 * accepts a positional path behaves anyway.
 */
export function substituteProjectPath(
  args: ReadonlyArray<string>,
  projectPath: string,
): ReadonlyArray<string> {
  return args.includes(PROJECT_PATH_PLACEHOLDER)
    ? args.map((arg) => (arg === PROJECT_PATH_PLACEHOLDER ? projectPath : arg))
    : [...args, projectPath];
}

/** Mirrors the `CustomEditor` schema bounds so a remembered entry always validates. */
const CUSTOM_EDITOR_LABEL_MAX_LENGTH = 64;
const CUSTOM_EDITOR_COMMAND_MAX_LENGTH = 1024;

/**
 * Whether a discovered application can be stored as a `CustomEditor`.
 *
 * A command longer than the schema allows would fail validation on write, so
 * such an application is left out of the list rather than offered and then
 * refused at the point the user picks it.
 */
export function isRememberableApplication(application: InstalledApplication): boolean {
  return (
    application.command.length <= CUSTOM_EDITOR_COMMAND_MAX_LENGTH &&
    application.name.slice(0, CUSTOM_EDITOR_LABEL_MAX_LENGTH).trim().length > 0 &&
    // `Exec=app "" %F` yields an empty argument, which the schema's
    // trimmed-non-empty check rejects on write. Leave the application out
    // rather than offering one that cannot be stored.
    application.args.every((arg) => arg.trim().length > 0)
  );
}

/**
 * Converts a discovered application into the entry persisted in settings.
 *
 * The label is trimmed after truncation: a name whose 64th character falls on
 * whitespace would otherwise carry a trailing space and fail the schema's
 * trimmed-string check.
 */
export function toCustomEditor(application: InstalledApplication): CustomEditor {
  return {
    id: `${CUSTOM_EDITOR_ID_PREFIX}${application.id}` as CustomEditorId,
    label: application.name.slice(0, CUSTOM_EDITOR_LABEL_MAX_LENGTH).trim(),
    command: application.command,
    args: application.args,
  };
}
