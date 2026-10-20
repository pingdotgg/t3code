import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const PROJECTS_DIR_ASSIGNMENT = /^[ \t]*XDG_PROJECTS_DIR[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)/;

/**
 * Reads `user-dirs.dirs` the way xdg-user-dirs' own `xdg-user-dir` does: the
 * value is quoted, starts with `$HOME` or `/`, a backslash keeps the next
 * character, and the last valid line wins. `$HOME` comes back as `~` so
 * clients show the directory the way they show the `~/` default, and the
 * result always ends in `/`.
 */
export function parseXdgProjectsDir(contents: string): Option.Option<string> {
  const roots = contents.split(/\r?\n/).flatMap((line) => {
    const quoted = PROJECTS_DIR_ASSIGNMENT.exec(line)?.[1];
    if (quoted === undefined) return [];
    const value = quoted.replace(/\\(.)/g, "$1");
    const root =
      value === "$HOME" || value.startsWith("$HOME/")
        ? `~${value.slice("$HOME".length)}`
        : value.startsWith("/")
          ? value
          : null;
    // Config strings are trimmed on the wire, and the separator keeps a
    // directory name that ends in whitespace intact
    return root === null ? [] : [root.replace(/\/*$/, "/")];
  });
  return Option.fromUndefinedOr(roots.at(-1));
}

/**
 * The directory xdg-user-dirs names for projects, when it exists.
 * xdg-user-dirs does not recreate a directory the user deleted, and Windows
 * and macOS have no such directory.
 */
export const resolveUserProjectsRoot = Effect.fn("resolveUserProjectsRoot")(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32" || platform === "darwin") return Option.none<string>();

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const configHome = (yield* HostProcess.Environment).XDG_CONFIG_HOME;
  // The base directory spec says to ignore a relative XDG_CONFIG_HOME
  const configDir =
    configHome !== undefined && path.isAbsolute(configHome)
      ? configHome
      : path.join(home, ".config");
  const root = Option.flatMap(
    yield* fileSystem.readFileString(path.join(configDir, "user-dirs.dirs")).pipe(Effect.option),
    parseXdgProjectsDir,
  );
  if (Option.isNone(root)) return root;

  const absoluteRoot = path.resolve(expandHomePath(root.value, home));
  // Pointing a user directory at home is how xdg-user-dirs disables it
  if (absoluteRoot === path.resolve(home)) return Option.none<string>();
  const info = yield* fileSystem.stat(absoluteRoot).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === "Directory" ? root : Option.none<string>();
});
