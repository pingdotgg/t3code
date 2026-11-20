import { type ArtifactRef, classifyArtifact } from "../domain/artifact";
import { BOARDS_DIR } from "../domain/board";
import type { ProjectFiles } from "./boardFiles";

export interface Artifact extends ArtifactRef {
  /** Where the file is on the engine's host, which the engine reads and serves it from. */
  readonly absolutePath: string;
}

/** What a read of one artifact came back with. */
export type ArtifactContents =
  | {
      readonly kind: "text";
      readonly contents: string;
      readonly byteLength: number;
      /** The engine cut the text at its read limit, so `byteLength` is more than `contents` holds. */
      readonly truncated: boolean;
    }
  | { readonly kind: "binary" }
  | { readonly kind: "missing" };

/** The file read the viewer goes through, which takes an absolute path. */
export type ReadArtifact = (cwd: string, absolutePath: string) => Promise<ArtifactContents>;

/**
 * Where an agent leaves its evidence inside its own worktree. The folder holds one folder per
 * ticket key, as the store's `artifacts/` does.
 */
export const WORKTREE_ARTIFACTS = ".omp/artifacts";

/** The store folders that hold artifacts, which keeps the listing out of `roles/` and the like. */
const ARTIFACT_FOLDERS: ReadonlyArray<string> = ["artifacts", "review", "inbox"];

/** Folders listed at once, which keeps a big store from flooding the socket. */
const LIST_BATCH = 16;

const trimSlashes = (path: string) => path.replace(/\/+$/, "");
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Runs `run` over `items` a batch at a time, in order. */
async function inBatches<T, R>(
  items: ReadonlyArray<T>,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += LIST_BATCH) {
    results.push(...(await Promise.all(items.slice(start, start + LIST_BATCH).map(run))));
  }
  return results;
}

/** Every file under a directory, which `projects.listEntries` lists one level at a time. Paths are relative to `cwd`. */
async function walk(files: ProjectFiles, cwd: string, directory: string): Promise<string[]> {
  const found: string[] = [];
  let level = [directory];
  while (level.length > 0) {
    const next: string[] = [];
    const listings = await inBatches(level, (path) => files.list(cwd, path));
    for (const entry of listings.flatMap((listing) => listing ?? [])) {
      if (baseName(entry.path).startsWith(".")) continue;
      (entry.kind === "directory" ? next : found).push(entry.path);
    }
    level = next;
  }
  return found;
}

async function listBoardFolder(
  files: ProjectFiles,
  workspaceRoot: string,
  folder: string,
): Promise<Artifact[]> {
  const root = `${BOARDS_DIR}/${folder}`;
  const top = (await files.list(workspaceRoot, root)) ?? [];
  const nested = await inBatches(
    top.filter(
      (entry) => entry.kind === "directory" && ARTIFACT_FOLDERS.includes(baseName(entry.path)),
    ),
    (entry) => walk(files, workspaceRoot, entry.path),
  );
  const paths = [
    ...top.filter((entry) => entry.kind === "file").map((entry) => entry.path),
    ...nested.flat(),
  ];
  return paths.flatMap((path): Artifact[] => {
    const under = path.slice(root.length + 1);
    const ref = classifyArtifact(under);
    return ref === null ? [] : [{ ...ref, absolutePath: `${trimSlashes(workspaceRoot)}/${path}` }];
  });
}

async function listWorktree(files: ProjectFiles, worktreePath: string): Promise<Artifact[]> {
  // The folder is outside the project, so the worktree is the `cwd` and the folder is relative to it.
  const paths = await walk(files, worktreePath, WORKTREE_ARTIFACTS).catch(
    // A worktree that was deleted or never created has no evidence, and must not hide the board's.
    () => [],
  );
  return paths.flatMap((path): Artifact[] => {
    const ref = classifyArtifact(`artifacts/${path.slice(WORKTREE_ARTIFACTS.length + 1)}`);
    return ref === null ? [] : [{ ...ref, absolutePath: `${trimSlashes(worktreePath)}/${path}` }];
  });
}

/**
 * The artifacts in a board's store folder and in the ticket worktrees, ordered by path. Every
 * `projects.listEntries` call takes a path relative to its `cwd`, because the engine refuses an
 * absolute one.
 */
export async function listArtifacts(
  files: ProjectFiles,
  input: {
    readonly workspaceRoot: string;
    readonly folder: string;
    readonly worktreePaths: ReadonlyArray<string>;
  },
): Promise<ReadonlyArray<Artifact>> {
  const worktrees = [...new Set(input.worktreePaths.map(trimSlashes))];
  const board = await listBoardFolder(files, input.workspaceRoot, input.folder);
  const fromWorktrees = await inBatches(worktrees, (path) => listWorktree(files, path));
  return [...board, ...fromWorktrees.flat()].toSorted((a, b) =>
    a.absolutePath.localeCompare(b.absolutePath),
  );
}

/** The listed artifact a README's file line names, or undefined when the README lists a file that is not listed. */
export function readmeTarget(
  readme: Artifact,
  file: string,
  artifacts: ReadonlyArray<Artifact>,
): Artifact | undefined {
  const parts = readme.absolutePath.split("/").slice(0, -1);
  for (const segment of file.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== "." && segment !== "") parts.push(segment);
  }
  const wanted = file.startsWith("/") ? file : parts.join("/");
  return artifacts.find((artifact) => artifact.absolutePath === wanted);
}
