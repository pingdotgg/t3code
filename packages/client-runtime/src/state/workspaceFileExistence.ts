import type {
  EnvironmentId,
  FilesystemEntryMetadata,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ThreadId,
} from "@t3tools/contracts";
import { isAbsolutePath, isNetworkPath } from "@t3tools/shared/path";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  needsWorkspaceBasenameLookup,
  pickStrippedWorkspaceMatch,
  pickWorkspaceBasenameMatch,
  stripRepeatedWorkspacePrefix,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
} from "../workspaceBasenameLookup.ts";

export interface WorkspaceFileCandidate {
  /** Host path the file would have if written literally. */
  readonly path: string;
  /** Workspace-relative path to search for when `path` is missing, as file links do on click. */
  readonly lookup: string | null;
}

export interface WorkspaceFileExistenceTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId | undefined;
  readonly cwd: string;
  readonly candidates: ReadonlyArray<WorkspaceFileCandidate>;
}

const NO_FILES = Atom.make<ReadonlySet<string>>(new Set()).pipe(
  Atom.withLabel("environment-data:projects:existing-files:none"),
);

function sameEntries(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

/**
 * Candidate paths confirmed to exist in the environment, read through the shared metadata
 * and search caches. Unknown, unreadable, and disconnected lookups count as missing.
 */
export function createWorkspaceFileExistenceAtom<MetadataError, SearchError>(
  fileMetadata: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly path: string; readonly threadId?: ThreadId };
  }) => Atom.Atom<AsyncResult.AsyncResult<FilesystemEntryMetadata | null, MetadataError>>,
  searchEntries: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: ProjectSearchEntriesInput;
  }) => Atom.Atom<AsyncResult.AsyncResult<ProjectSearchEntriesResult, SearchError>>,
) {
  const family = Atom.family((key: string) => {
    const target = JSON.parse(key) as WorkspaceFileExistenceTarget;
    return Atom.make((get): ReadonlySet<string> => {
      const found = new Set<string>();
      for (const { path, lookup } of target.candidates) {
        const metadata = AsyncResult.getOrElse(
          get(
            fileMetadata({
              environmentId: target.environmentId,
              input: { path, ...(target.threadId ? { threadId: target.threadId } : {}) },
            }),
          ),
          () => undefined,
        );
        if (metadata) found.add(path);
        if (metadata !== null || lookup === null) continue;
        const basename = needsWorkspaceBasenameLookup(lookup);
        const stripped = basename ? null : stripRepeatedWorkspacePrefix(lookup, target.cwd);
        if (!basename && stripped === null) continue;
        const result = AsyncResult.getOrElse(
          get(
            searchEntries({
              environmentId: target.environmentId,
              input: {
                cwd: target.cwd,
                query: stripped ?? lookup,
                limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
                kind: "file",
              },
            }),
          ),
          () => null,
        );
        const match =
          result === null
            ? null
            : stripped === null
              ? pickWorkspaceBasenameMatch(lookup, result.entries)
              : pickStrippedWorkspaceMatch(stripped, target.cwd, result.entries);
        if (match !== null) found.add(path);
      }
      const previous = Option.getOrNull(get.self<ReadonlySet<string>>());
      return previous !== null && sameEntries(previous, found) ? previous : found;
    }).pipe(Atom.withLabel("environment-data:projects:existing-files"));
  });
  return (target: WorkspaceFileExistenceTarget | null): Atom.Atom<ReadonlySet<string>> => {
    if (target === null) return NO_FILES;
    // Servers stat what they are asked about, and a network path leaks the
    // Windows user's NTLM credentials to its host before anything is clicked.
    const candidates = target.candidates.filter(
      ({ path }) =>
        (isAbsolutePath(path) || path.startsWith("~/")) &&
        !isNetworkPath(path) &&
        path.length <= 512,
    );
    if (candidates.length === 0) return NO_FILES;
    return family(
      JSON.stringify({
        environmentId: target.environmentId,
        ...(target.threadId ? { threadId: target.threadId } : {}),
        cwd: target.cwd,
        candidates,
      }),
    );
  };
}
