import {
  ORCHESTRATION_V2_OUTSIDE_EDIT_FILES_MAX,
  type OrchestrationV2CheckpointOutsideEdit,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const OUTSIDE_EDITS_MAX = 32;
const LOOKUP_CONCURRENCY = 4;

/**
 * Groups a run's reported file edits by the Git repo that holds them and keeps the repos no
 * checkpoint of the run covers. A repo root is the nearest folder with a `.git` entry, so this
 * reads the filesystem only. Edits in the thread's own folder that belong to it are never outside.
 */
export const collectOutsideEdits = Effect.fn("OutsideEdits.collect")(function* (input: {
  /** As the provider reported them; relative paths resolve against `cwd`. */
  readonly paths: ReadonlyArray<string>;
  readonly cwd: string;
  /** The thread's agent folder. */
  readonly homeCwd: string;
  /** Folders whose repos have a checkpoint in this run. */
  readonly coveredCwds: ReadonlyArray<string>;
  /** The project's home and tracked folders; a repo root among them is `tracked`. Read lazily. */
  readonly projectFolderPaths: Effect.Effect<ReadonlyArray<string>>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  // Deleted files and folders resolve through their nearest existing ancestor.
  const realFolders = new Map<string, string>();
  const realFolder = Effect.fnUntraced(function* (folder: string) {
    const cached = realFolders.get(folder);
    if (cached !== undefined) return cached;
    const missing: Array<string> = [];
    let current = folder;
    let resolved = folder;
    while (true) {
      const real = yield* fileSystem.realPath(current).pipe(Effect.option);
      if (Option.isSome(real)) {
        resolved = path.join(real.value, ...missing.toReversed());
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      missing.push(path.basename(current));
      current = parent;
    }
    realFolders.set(folder, resolved);
    return resolved;
  });

  const repositoryRoots = new Map<string, string | null>();
  const repositoryRoot = Effect.fnUntraced(function* (realFolderPath: string) {
    const visited: Array<string> = [];
    let current = realFolderPath;
    let root: string | null = null;
    while (true) {
      const cached = repositoryRoots.get(current);
      if (cached !== undefined) {
        root = cached;
        break;
      }
      visited.push(current);
      if (
        yield* fileSystem.exists(path.join(current, ".git")).pipe(Effect.orElseSucceed(() => false))
      ) {
        root = current;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const folder of visited) repositoryRoots.set(folder, root);
    return root;
  });

  const files = [
    ...new Set(
      input.paths.map((reported) =>
        path.isAbsolute(reported) ? path.normalize(reported) : path.resolve(input.cwd, reported),
      ),
    ),
  ];
  const located = yield* Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        const folder = yield* realFolder(path.dirname(file));
        return {
          file: path.join(folder, path.basename(file)),
          root: yield* repositoryRoot(folder),
        };
      }),
    { concurrency: LOOKUP_CONCURRENCY },
  );
  const home = yield* realFolder(input.homeCwd);
  const covered = new Set(
    yield* Effect.forEach(input.coveredCwds, (cwd) =>
      realFolder(cwd).pipe(Effect.flatMap(repositoryRoot)),
    ),
  );

  const filesByRoot = new Map<string, Set<string>>();
  for (const { file, root } of located) {
    if (root === null || covered.has(root)) continue;
    if (contains(home, file) && !(root !== home && contains(home, root))) continue;
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (relative.trim() === "") continue;
    const rootFiles = filesByRoot.get(root) ?? new Set<string>();
    rootFiles.add(relative);
    filesByRoot.set(root, rootFiles);
  }
  if (filesByRoot.size === 0) return [];

  const tracked = new Set(
    yield* Effect.forEach(yield* input.projectFolderPaths, (folder) => realFolder(folder)),
  );
  return [...filesByRoot]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .slice(0, OUTSIDE_EDITS_MAX)
    .flatMap(([root, rootFiles]): Array<OrchestrationV2CheckpointOutsideEdit> => {
      const name = path.basename(root);
      if (name.trim() === "") return [];
      const sorted = [...rootFiles].toSorted();
      return [
        {
          root,
          name,
          tracked: tracked.has(root),
          files: sorted.slice(0, ORCHESTRATION_V2_OUTSIDE_EDIT_FILES_MAX),
          fileCount: sorted.length,
        },
      ];
    });
});
