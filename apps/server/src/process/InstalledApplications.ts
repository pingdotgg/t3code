/**
 * Applications installed on this host, for the "Open with" list. Scanning runs
 * where the command will run, so one list serves local, remote, and mobile.
 * Linux only: `.lnk` shortcuts drop the project path and macOS needs its own
 * bundle-precedence rules.
 *
 * @module InstalledApplications
 */
import type { InstalledApplication } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

/** Freedesktop field codes; only the file/URL ones mark the project path. */
const PATH_FIELD_CODE = /^%[fFuU]$/;
const OTHER_FIELD_CODE = /^%[dDnNickvm]$/;

/** Where the path goes, so `editor %F --new-window` keeps that order. */
export const PROJECT_PATH_SLOT = "%%T3_PROJECT_PATH%%";

/** One argument: bare chars, escapes, and quoted runs, glued together. */
const EXEC_TOKEN = /(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')+/g;

/** Splits `Exec=`: quotes hold spaces, `\` escapes the next char anywhere. */
export function parseExec(exec: string): ReadonlyArray<string> {
  let slotted = false;
  const args: string[] = [];
  for (const token of exec.match(EXEC_TOKEN) ?? []) {
    // Quotes off first, so their inner escapes survive the unescape.
    const value = token
      .replace(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g, "$1$2")
      .replace(/\\(.)/g, "$1");
    if (OTHER_FIELD_CODE.test(value)) continue;
    if (PATH_FIELD_CODE.test(value)) {
      // An entry may list several; a project opens in one place.
      if (!slotted) args.push(PROJECT_PATH_SLOT);
      slotted = true;
      continue;
    }
    if (value.length > 0) args.push(value);
  }
  return args;
}

/** One `.desktop` file, or null if it is not a launchable, visible app. */
export function parseDesktopEntry(contents: string): Omit<InstalledApplication, "id"> | null {
  const fields: Record<string, string> = {};
  let inEntry = false;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inEntry) continue;
    const separator = line.indexOf("=");
    // Skip localized keys (`Name[de]`).
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (key.length === 0 || key.includes("[") || key in fields) continue;
    fields[key] = line.slice(separator + 1).trim();
  }

  if (fields.Type !== undefined && fields.Type !== "Application") return null;
  // A terminal program opens a console, not the project.
  if (fields.NoDisplay === "true" || fields.Hidden === "true" || fields.Terminal === "true") {
    return null;
  }
  const name = fields.Name?.trim();
  if (!name || fields.Exec === undefined) return null;
  const [command, ...args] = parseExec(fields.Exec);
  if (command === undefined) return null;
  return { name, command, args };
}

/** Resolves an application's stored arguments against a project path. */
export function withProjectPath(args: ReadonlyArray<string>, projectPath: string) {
  return args.includes(PROJECT_PATH_SLOT)
    ? args.map((arg) => (arg === PROJECT_PATH_SLOT ? projectPath : arg))
    : [...args, projectPath];
}

const scanLinux = Effect.fn("installedApplications.scanLinux")(function* (
  home: string,
  env: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // `||` not `??`: an empty XDG var means unset, and treating it as set would
  // drop the system directories.
  const roots = [
    env.XDG_DATA_HOME || path.join(home, ".local", "share"),
    ...(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean),
  ];

  const entries: InstalledApplication[] = [];
  // XDG keys an entry by filename, first root wins. Claiming before parsing is
  // what lets a user's `Hidden=true` hide the system copy instead of falling
  // through to it.
  const claimed = new Set<string>();
  for (const root of roots) {
    const directory = path.join(root, "applications");
    // Absent or unreadable directories are normal here.
    const names = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const fileName of names) {
      if (!fileName.endsWith(".desktop") || claimed.has(fileName)) continue;
      claimed.add(fileName);
      const contents = yield* fileSystem
        .readFileString(path.join(directory, fileName))
        .pipe(Effect.orElseSucceed(() => ""));
      const parsed = contents.length > 0 ? parseDesktopEntry(contents) : null;
      // Filename is the XDG id: unique by the claim above, stable next scan.
      if (parsed !== null) entries.push({ ...parsed, id: fileName });
    }
  }
  return entries;
});

export class InstalledApplications extends Context.Service<
  InstalledApplications,
  { readonly list: Effect.Effect<ReadonlyArray<InstalledApplication>> }
>()("t3/process/InstalledApplications") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  // ponytail: rescans per open. Dozens of small reads, opened by hand; cache
  // it if a host with a huge registry drags.
  return InstalledApplications.of({
    list: Effect.gen(function* () {
      if (platform !== "linux") return [];
      const home = env.HOME || env.USERPROFILE || "";
      const entries = yield* scanLinux(home, env);
      return entries
        .toSorted((left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
        )
        .slice(0, 500); // bound the payload; no host has this many launchers
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.withSpan("installedApplications.scan"),
    ),
  });
});

export const layer = Layer.effect(InstalledApplications, make);
