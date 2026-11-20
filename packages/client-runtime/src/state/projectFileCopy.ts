import type {
  EnvironmentId,
  ProjectCloneSnapshot,
  ProjectId,
  ProjectIgnoredFile,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
} from "@t3tools/contracts";
import type { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { thrownErrorMessage } from "../errors/translatable.ts";

import {
  type AtomCommand,
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "./runtime.ts";

/** Matches the server's read cap: a larger file would arrive truncated. */
export const COPYABLE_FILE_MAX_BYTES = 1024 * 1024;

/** The server lists at most this many ignored files, so one pick never exceeded it. */
export const COPIED_FILES_MAX_COUNT = 200;

const DEFAULT_COPIED_FILE_NAME = /^(?:\.env(?:\..+)?|\.envrc|\.dev\.vars)$/;

/** Env files are the ignored files people almost always want on a new machine. */
function isDefaultCopiedFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return DEFAULT_COPIED_FILE_NAME.test(name);
}

/** The ignored files selected before the user changes anything, keyed by path. */
export function defaultCopiedFiles(
  files: readonly ProjectIgnoredFile[],
): ReadonlyMap<string, ProjectIgnoredFile> {
  return new Map(
    files
      .filter(
        (file) => file.byteLength <= COPYABLE_FILE_MAX_BYTES && isDefaultCopiedFile(file.path),
      )
      .map((file) => [file.path, file]),
  );
}

/**
 * A project can be rooted below its repository's top folder. The clone lands
 * at the top, so copied files keep the same path below it.
 */
export function projectSubdirectory(repositoryRoot: string | undefined, workspaceRoot: string) {
  if (!repositoryRoot) return "";
  // git reports Windows roots with forward slashes; the workspace keeps the user's separators.
  const normalize = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");
  const prefix = normalize(repositoryRoot);
  const root = normalize(workspaceRoot);
  // Windows drive paths are case-insensitive; POSIX paths are not.
  const fold = (path: string) => (/^[a-z]:\//i.test(root) ? path.toLowerCase() : path);
  return fold(root).startsWith(`${fold(prefix)}/`) ? root.slice(prefix.length + 1) : "";
}

interface ProjectFileAtoms {
  readonly readFile: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: ProjectReadFileInput;
  }) => Atom.Atom<AsyncResult.AsyncResult<ProjectReadFileResult, unknown>>;
  readonly writeFile: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: ProjectWriteFileInput },
    unknown,
    unknown
  >;
}

export type ProjectFileRead =
  | { readonly relativePath: string; readonly contents: string }
  | { readonly relativePath: string; readonly error: string };

function failureMessage(
  result: Parameters<typeof squashAtomCommandFailure>[0],
  resolve: MFunctionType,
): string {
  const error = squashAtomCommandFailure(result);
  return thrownErrorMessage(error, resolve) ?? resolve(msg("An error occurred."));
}

/** Run before the clone starts, so the copy reflects the files as they were when the user asked. */
export function readProjectFilesToCopy(
  registry: AtomRegistry.AtomRegistry,
  atoms: Pick<ProjectFileAtoms, "readFile">,
  source: { readonly environmentId: EnvironmentId; readonly cwd: string },
  relativePaths: ReadonlyArray<string>,
  resolve: MFunctionType = mFallback,
): Promise<ReadonlyArray<ProjectFileRead>> {
  return Promise.all(
    relativePaths.map(async (relativePath): Promise<ProjectFileRead> => {
      const result = await executeAtomQuery(
        registry,
        atoms.readFile({
          environmentId: source.environmentId,
          input: { cwd: source.cwd, relativePath },
        }),
        { label: "Read file to copy", reportFailure: false, refresh: true },
      );
      if (result._tag === "Failure")
        return { relativePath, error: failureMessage(result, resolve) };
      if (result.value.truncated) {
        return { relativePath, error: resolve(msg("Too large to copy.")) };
      }
      return { relativePath, contents: result.value.contents };
    }),
  );
}

type ProjectClonesAtom = Atom.Atom<
  AsyncResult.AsyncResult<ReadonlyArray<ProjectCloneSnapshot>, unknown>
>;

/**
 * Resolves when the clone finishes, or null once a list from the server no
 * longer has it. A failed or cancelled clone keeps waiting, since the composer
 * offers a retry, and so does a list that is loading or unavailable.
 */
function waitForProjectClone(
  registry: AtomRegistry.AtomRegistry,
  clonesAtom: ProjectClonesAtom,
  sessionGenerationAtom: Atom.Atom<number>,
  projectId: ProjectId,
) {
  return new Promise<ProjectCloneSnapshot | null>((resolve) => {
    let seen = false;
    // The server lists a clone before `start` replies and sends each new subscription the
    // current list, so a missing clone is gone once it was seen, or on the first list after
    // the subscription restarted or a new session came up. The cached list predates the start.
    let freshList = false;
    let settled = false;
    const unsubscribes: Array<() => void> = [];
    const check = (
      clones: AsyncResult.AsyncResult<ReadonlyArray<ProjectCloneSnapshot>, unknown>,
    ) => {
      if (settled) return;
      if (clones._tag !== "Success") {
        freshList = true;
        return;
      }
      const clone = clones.value.find((candidate) => candidate.projectId === projectId);
      if (clone) seen = true;
      const gone = !clone && (seen || freshList);
      const result = clone?.phase === "done" ? clone : gone ? null : undefined;
      if (result === undefined) return;
      settled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      resolve(result);
    };
    unsubscribes.push(
      registry.subscribe(sessionGenerationAtom, () => {
        freshList = true;
      }),
      registry.subscribe(clonesAtom, check),
    );
    check(registry.get(clonesAtom));
  });
}

/**
 * Relays the files once the clone is done, since the two servers never talk.
 * Resolves with one line per file that did not arrive.
 */
export async function writeProjectFilesAfterClone(
  registry: AtomRegistry.AtomRegistry,
  atoms: Pick<ProjectFileAtoms, "writeFile">,
  input: {
    /** The target's clone subscription; only lists the server sent are trusted. */
    readonly clonesAtom: ProjectClonesAtom;
    /** The target's established-session count; a new session means a fresh clone list. */
    readonly sessionGenerationAtom: Atom.Atom<number>;
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    /** The clone's top folder on the target machine. */
    readonly cwd: string;
    /** Where the source project sits below its repository root, or "". */
    readonly subdirectory: string;
    readonly reads: ReadonlyArray<ProjectFileRead>;
  },
  resolve: MFunctionType = mFallback,
): Promise<ReadonlyArray<string>> {
  const clone = await waitForProjectClone(
    registry,
    input.clonesAtom,
    input.sessionGenerationAtom,
    input.projectId,
  );
  // The server drops a finished clone after a short while, so a device that was away can miss it.
  if (!clone) {
    return input.reads.map(
      (read) =>
        `${read.relativePath}: ${resolve(msg("The clone was gone before this file could be copied."))}`,
    );
  }
  const failed: Array<string> = [];
  for (const read of input.reads) {
    if (!("contents" in read)) {
      failed.push(`${read.relativePath}: ${read.error}`);
      continue;
    }
    const written = await runAtomCommand(
      registry,
      atoms.writeFile,
      {
        environmentId: input.environmentId,
        input: {
          cwd: input.cwd,
          relativePath: input.subdirectory
            ? `${input.subdirectory}/${read.relativePath}`
            : read.relativePath,
          contents: read.contents,
        },
      },
      { label: "Copy file to machine", reportFailure: false },
    );
    if (written._tag === "Failure")
      failed.push(`${read.relativePath}: ${failureMessage(written, resolve)}`);
  }
  return failed;
}
