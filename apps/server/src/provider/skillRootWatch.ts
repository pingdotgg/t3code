/**
 * skillRootWatch — reports when a provider skill root may have gained, lost,
 * or changed a skill, so the registry can rescan the workspace skill lists
 * it holds instead of keeping them until an explicit refresh.
 *
 * A skill root holds one directory per skill, each with a `SKILL.md`. Only
 * changes that can alter the list count: an entry appearing, disappearing, or
 * being renamed directly under the root (a skill directory or a symlink to
 * one), and a skill's `SKILL.md` changing. Scripts, assets, dotfiles, and
 * editor temp files are ignored. Edits behind a symlinked skill directory are
 * not observed; the explicit refresh still covers those.
 *
 * @module provider/skillRootWatch
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

// Dotfiles (including `.system`, `.DS_Store`, and `.#` / `.swp` editor
// files), backup files, and Vim's `4913` write probe.
const IGNORED_ENTRY = /^\.|~$|\.tmp$|^4913$/;

/** Whether a change at `relativePath` (relative to a skill root) can alter its skill list. */
export function isSkillListChange(relativePath: string): boolean {
  const [entry, file, ...rest] = relativePath.split(/[\\/]/).filter((segment) => segment !== "");
  if (entry === undefined || rest.length > 0 || IGNORED_ENTRY.test(entry)) return false;
  return file === undefined || file === "SKILL.md";
}

/**
 * Emits whenever `root` may have changed its skill list. A missing root is
 * watched through its parent and picked up once created; when the parent is
 * missing too the root is not watched, because the nearest existing ancestor
 * is often a home directory or repository whose whole tree the OS would
 * report. Watch failures end the stream for that root.
 */
export const watchSkillRoot = (
  root: string,
): Stream.Stream<void, never, FileSystem.FileSystem | Path.Path> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const exists = (target: string) =>
        fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
      if (yield* exists(root)) {
        return fileSystem.watch(root, { recursive: true }).pipe(
          Stream.filter((event) =>
            isSkillListChange(path.relative(root, path.resolve(root, event.path))),
          ),
          Stream.as(undefined),
        );
      }
      const parent = path.dirname(root);
      if (parent === root || !(yield* exists(parent))) return Stream.empty;
      return fileSystem.watch(parent).pipe(
        Stream.filter((event) => path.resolve(parent, event.path) === root),
        Stream.take(1),
        Stream.as(undefined),
        Stream.concat(Stream.suspend(() => watchSkillRoot(root))),
      );
    }),
  ).pipe(Stream.ignoreCause({ log: "Debug" }));

/** Merges {@link watchSkillRoot} over `roots`, emitting the root that changed. */
export const watchSkillRoots = (
  roots: Iterable<string>,
): Stream.Stream<string, never, FileSystem.FileSystem | Path.Path> =>
  Stream.mergeAll(
    Array.from(roots, (root) => watchSkillRoot(root).pipe(Stream.as(root))),
    { concurrency: "unbounded" },
  );
