/**
 * Workspace queries fanned out across a project's source folders.
 *
 * Every workspace RPC is keyed on a single `cwd`, so a project with N folders
 * means N calls. Rather than widen the wire contract, the client issues them
 * concurrently and merges the results — the server already memoizes one search
 * index per root, and a per-folder failure can then grey out one subtree instead
 * of failing the whole surface.
 *
 * The variable folder count would break the rules of hooks if each folder got
 * its own `useAtomValue`, so the queries are combined into a single derived atom
 * first. This mirrors `createUrlsFamily` in
 * `packages/client-runtime/src/state/assets.ts`.
 *
 * @module workspaceFolderQueries
 */
import type { EnvironmentId, ProjectEntryKind } from "@t3tools/contracts";
import type { WorkspaceFolder } from "@t3tools/shared/workspaceFolders";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { projectContentSearch, projectEnvironment } from "~/state/projects";

const FOLDER_QUERY_IDLE_TTL_MS = 60_000;

/** One folder's slice of a fanned-out query. */
export interface WorkspaceFolderQueryResult<A> {
  readonly folder: WorkspaceFolder;
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export interface WorkspaceFolderQueryView<A> {
  readonly results: ReadonlyArray<WorkspaceFolderQueryResult<A>>;
  /** True while any folder is still loading. */
  readonly isPending: boolean;
  /** Set only when every folder failed; a partial failure stays per-folder. */
  readonly error: string | null;
  readonly refresh: () => void;
}

function formatCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const EMPTY_COMBINED_ATOM = Atom.make(
  [] as ReadonlyArray<AsyncResult.AsyncResult<never, never>>,
).pipe(Atom.withLabel("workspace-folders:empty"));

/**
 * Combine one atom per folder into a single atom of results.
 *
 * Keyed on the serialized inputs so that the same folder set and query reuse
 * the same combined atom across renders.
 */
function makeCombinedFamily<TInput, TResult>(
  label: string,
  makeAtom: (input: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly input: TInput;
  }) => Atom.Atom<AsyncResult.AsyncResult<TResult, unknown>>,
) {
  return Atom.family((key: string) => {
    const { environmentId, cwds, input } = JSON.parse(key) as {
      environmentId: EnvironmentId;
      cwds: ReadonlyArray<string>;
      input: TInput;
    };
    return Atom.make((get) => cwds.map((cwd) => get(makeAtom({ environmentId, cwd, input })))).pipe(
      Atom.setIdleTTL(FOLDER_QUERY_IDLE_TTL_MS),
      Atom.withLabel(`${label}:${key}`),
    );
  });
}

const listEntriesFamily = makeCombinedFamily<Record<string, never>, unknown>(
  "workspace-folders:list-entries",
  ({ environmentId, cwd }) => projectEnvironment.listEntries({ environmentId, input: { cwd } }),
);

const searchEntriesFamily = makeCombinedFamily<
  { query: string; limit: number; kind?: ProjectEntryKind },
  unknown
>("workspace-folders:search-entries", ({ environmentId, cwd, input }) =>
  projectEnvironment.searchEntries({
    environmentId,
    input: {
      cwd,
      query: input.query,
      limit: input.limit,
      ...(input.kind ? { kind: input.kind } : {}),
    },
  }),
);

interface FolderContentSearchInput {
  readonly query: string;
  readonly limit: number;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly useRegex: boolean;
}

const searchContentsFamily = makeCombinedFamily<FolderContentSearchInput, unknown>(
  "workspace-folders:search-contents",
  ({ environmentId, cwd, input }) =>
    projectContentSearch({
      environmentId,
      input: {
        cwd,
        query: input.query,
        limit: input.limit,
        caseSensitive: input.caseSensitive,
        wholeWord: input.wholeWord,
        useRegex: input.useRegex,
      },
    }),
);

function useCombinedFolderQuery<A>(
  family: (key: string) => Atom.Atom<ReadonlyArray<AsyncResult.AsyncResult<unknown, unknown>>>,
  input: {
    readonly environmentId: EnvironmentId | null;
    readonly folders: ReadonlyArray<WorkspaceFolder>;
    readonly input: unknown;
    readonly enabled: boolean;
  },
): WorkspaceFolderQueryView<A> {
  const key = useMemo(
    () =>
      input.enabled && input.environmentId !== null && input.folders.length > 0
        ? JSON.stringify({
            environmentId: input.environmentId,
            cwds: input.folders.map((folder) => folder.cwd),
            input: input.input,
          })
        : null,
    [input.enabled, input.environmentId, input.folders, input.input],
  );

  const atom = key === null ? EMPTY_COMBINED_ATOM : family(key);
  const raw = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);

  const results = useMemo(
    () =>
      input.folders.map((folder, index) => {
        const entry = raw[index];
        if (entry === undefined) {
          return { folder, data: null, error: null, isPending: key !== null };
        }
        return {
          folder,
          data: (Option.getOrNull(AsyncResult.value(entry)) as A | null) ?? null,
          error: entry._tag === "Failure" ? formatCause(entry.cause) : null,
          isPending: entry.waiting,
        };
      }),
    [input.folders, key, raw],
  );

  const everyFolderFailed = results.length > 0 && results.every((result) => result.error !== null);

  return {
    results,
    isPending: results.some((result) => result.isPending),
    // A single unreachable folder greys out its own subtree rather than
    // failing the whole surface.
    error: everyFolderFailed ? (results[0]?.error ?? null) : null,
    refresh,
  };
}

export function useWorkspaceFolderEntries<A>(input: {
  readonly environmentId: EnvironmentId | null;
  readonly folders: ReadonlyArray<WorkspaceFolder>;
  readonly enabled?: boolean;
}): WorkspaceFolderQueryView<A> {
  const empty = useMemo(() => ({}), []);
  return useCombinedFolderQuery<A>(listEntriesFamily, {
    environmentId: input.environmentId,
    folders: input.folders,
    input: empty,
    enabled: input.enabled !== false,
  });
}

export function useWorkspaceFolderPathSearch<A>(input: {
  readonly environmentId: EnvironmentId | null;
  readonly folders: ReadonlyArray<WorkspaceFolder>;
  readonly query: string;
  readonly limit: number;
  readonly kind?: ProjectEntryKind;
  readonly enabled?: boolean;
}): WorkspaceFolderQueryView<A> {
  const queryInput = useMemo(
    () => ({
      query: input.query,
      limit: input.limit,
      ...(input.kind ? { kind: input.kind } : {}),
    }),
    [input.kind, input.limit, input.query],
  );
  return useCombinedFolderQuery<A>(searchEntriesFamily, {
    environmentId: input.environmentId,
    folders: input.folders,
    input: queryInput,
    enabled: input.enabled !== false,
  });
}

export function useWorkspaceFolderContentSearch<A>(input: {
  readonly environmentId: EnvironmentId | null;
  readonly folders: ReadonlyArray<WorkspaceFolder>;
  readonly query: string;
  readonly limit: number;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly useRegex: boolean;
  readonly enabled?: boolean;
}): WorkspaceFolderQueryView<A> {
  const queryInput = useMemo(
    () => ({
      query: input.query,
      limit: input.limit,
      caseSensitive: input.caseSensitive,
      wholeWord: input.wholeWord,
      useRegex: input.useRegex,
    }),
    [input.caseSensitive, input.limit, input.query, input.useRegex, input.wholeWord],
  );
  return useCombinedFolderQuery<A>(searchContentsFamily, {
    environmentId: input.environmentId,
    folders: input.folders,
    input: queryInput,
    enabled: input.enabled !== false,
  });
}
