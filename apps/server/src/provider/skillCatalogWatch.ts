import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export function skillCatalogPathsFromSkills(
  path: Path.Path,
  skillPaths: ReadonlyArray<string>,
): ReadonlyArray<{ readonly path: string; readonly recursive: boolean }> {
  return [
    ...new Set(
      skillPaths.map((skillPath) => {
        const skillDirectory = path.resolve(path.dirname(skillPath));
        const catalogDirectory = path.dirname(skillDirectory);
        return path.dirname(catalogDirectory) === catalogDirectory
          ? skillDirectory
          : catalogDirectory;
      }),
    ),
  ].map((directory) => ({ path: directory, recursive: true }));
}

export const skillCatalogWatchTargets = Effect.fn("skillCatalogWatchTargets")(function* (
  watchPaths: ReadonlyArray<{ readonly path: string; readonly recursive: boolean }>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = [
    ...new Map(
      watchPaths.map((watchPath) => [
        `${path.resolve(watchPath.path)}\0${watchPath.recursive}`,
        { path: path.resolve(watchPath.path), recursive: watchPath.recursive },
      ]),
    ).values(),
  ];
  const targets = new Map<
    string,
    {
      readonly path: string;
      readonly recursive: boolean;
      readonly expectedPaths: ReadonlySet<string> | undefined;
    }
  >();
  const addTarget = (watchPath: string, recursive: boolean, expectedPath?: string) => {
    const key = `${watchPath}\0${recursive}`;
    const existing = targets.get(key);
    if (existing?.expectedPaths === undefined && targets.has(key)) return;
    if (expectedPath === undefined) {
      targets.set(key, { path: watchPath, recursive, expectedPaths: undefined });
      return;
    }
    targets.set(key, {
      path: watchPath,
      recursive,
      expectedPaths: new Set([...(existing?.expectedPaths ?? []), expectedPath]),
    });
  };

  for (const root of roots) {
    const info = yield* fileSystem.stat(root.path).pipe(Effect.orElseSucceed(() => undefined));
    if (info !== undefined) {
      addTarget(root.path, root.recursive && info.type === "Directory");
      continue;
    }

    let expectedPath = root.path;
    while (true) {
      const parent = path.dirname(expectedPath);
      if (parent === expectedPath || path.dirname(parent) === parent) break;
      const parentInfo = yield* fileSystem.stat(parent).pipe(Effect.orElseSucceed(() => undefined));
      if (parentInfo?.type === "Directory") {
        addTarget(parent, false, expectedPath);
        break;
      }
      expectedPath = parent;
    }
  }

  return [...targets.values()].map((target) => ({
    ...target,
    expectedPaths:
      target.expectedPaths === undefined ? undefined : [...target.expectedPaths].sort(),
  }));
});

export function skillCatalogWatchEventAffectsTarget(
  path: Path.Path,
  target: {
    readonly path: string;
    readonly expectedPaths: ReadonlyArray<string> | undefined;
  },
  event: FileSystem.WatchEvent,
): boolean {
  if (target.expectedPaths === undefined) return true;
  const reportedPath = path.resolve(target.path, event.path);
  return target.expectedPaths.some(
    (expectedPath) =>
      reportedPath === expectedPath || reportedPath.startsWith(`${expectedPath}${path.sep}`),
  );
}
