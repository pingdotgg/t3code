/**
 * skillRootWatch — reports when a provider skill root may have gained, lost,
 * or changed a skill, so the registry can rescan the workspace skill lists
 * it holds instead of keeping them until an explicit refresh.
 *
 * A skill root holds one directory per skill, each with a `SKILL.md`. Only
 * changes that can alter the list count: an entry appearing, disappearing, or
 * being renamed directly under the root (a skill directory or a symlink to
 * one), and any `SKILL.md` changing. Codex loads `SKILL.md` files nested below
 * a root too, so a nested one counts even though Claude ignores it. Moving a
 * populated skill directory into or out of a nested group reports only the
 * directory, so a directory appearing at any depth counts, and so does any
 * removal at depth, because a removed path can no longer be checked for being
 * a directory. Anything else deeper in a skill, such as edited scripts,
 * assets, or new editor temp files, is ignored. Entries directly under the
 * root are not filtered by name, because any directory name can hold a skill.
 * Edits behind a symlinked skill directory are not observed; the explicit
 * refresh still covers those.
 *
 * @module provider/skillRootWatch
 */
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

/** Whether a change at `relativePath` (relative to a skill root) can alter its skill list. */
export function isSkillListChange(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/).filter((segment) => segment !== "");
  if (segments.length === 0) return false;
  return segments.length === 1 || segments.at(-1) === "SKILL.md";
}

/**
 * Emits whenever `root` may have changed its skill list.
 *
 * An existing root is watched recursively, and its parent non-recursively so
 * a removed or replaced root is picked up again. A missing root is watched
 * through its nearest existing ancestor, non-recursively, one path segment at
 * a time until it exists. A home directory or filesystem root is never
 * watched, so a root whose nearest existing ancestor is one of those stays
 * unwatched. Watch failures end the stream for that root.
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
      const isDirectory = (target: string) =>
        fileSystem.stat(target).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );
      const changesSkillList = (event: FileSystem.WatchEvent) => {
        const target = path.resolve(root, event.path);
        if (isSkillListChange(path.relative(root, target))) return Effect.succeed(true);
        switch (event._tag) {
          case "Remove":
            return Effect.succeed(true);
          case "Create":
            return isDirectory(target);
          default:
            return Effect.succeed(false);
        }
      };
      // Start over only after the event that changed the root's state, never
      // because a watch ended on its own, which would spin.
      let rootStateChanged = false;
      const markRootStateChanged = Effect.sync(() => {
        rootStateChanged = true;
      });
      const watchAgainIfChanged = Stream.suspend(() =>
        rootStateChanged ? watchSkillRoot(root) : Stream.empty,
      );

      if (yield* exists(root)) {
        const parent = path.dirname(root);
        const changes = fileSystem.watch(root, { recursive: true }).pipe(
          Stream.filterEffect(changesSkillList),
          Stream.as(false),
          // The root can vanish between the exists check and the watch starting.
          // Treat that as a root change so it is followed again; any other
          // failure leaves the parent watch running alone.
          Stream.catchCause(() =>
            Stream.unwrap(
              exists(root).pipe(
                Effect.map((stillExists) => (stillExists ? Stream.empty : Stream.make(true))),
              ),
            ),
          ),
        );
        const replaced = fileSystem.watch(parent).pipe(
          Stream.filter((event) => path.resolve(parent, event.path) === root),
          Stream.as(true),
        );
        return Stream.merge(changes, replaced).pipe(
          Stream.takeUntil((rootReplaced) => rootReplaced),
          Stream.tap((rootReplaced) => (rootReplaced ? markRootStateChanged : Effect.void)),
          Stream.as(undefined),
          Stream.concat(watchAgainIfChanged),
        );
      }

      let ancestor = path.dirname(root);
      while (!(yield* exists(ancestor))) {
        if (path.dirname(ancestor) === ancestor) return Stream.empty;
        ancestor = path.dirname(ancestor);
      }
      if (path.dirname(ancestor) === ancestor || ancestor === path.resolve(NodeOS.homedir())) {
        return Stream.empty;
      }
      const next = path.join(ancestor, path.relative(ancestor, root).split(path.sep)[0] ?? "");
      return fileSystem.watch(ancestor).pipe(
        Stream.filter((event) => path.resolve(ancestor, event.path) === next),
        Stream.take(1),
        Stream.tap(() => markRootStateChanged),
        Stream.as(undefined),
        Stream.concat(watchAgainIfChanged),
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
