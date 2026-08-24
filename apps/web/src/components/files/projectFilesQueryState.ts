import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectListEntriesResult,
  ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

const EMPTY_PROJECT_FILE_PATH = "";
const EMPTY_PROJECT_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("project-file-query:empty"));
function optimisticFileAtom(environmentId: EnvironmentId, cwd: string, relativePath: string) {
  return projectEnvironment.optimisticFile({ environmentId, cwd, relativePath });
}

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function getProjectEntriesQueryAtom(environmentId: EnvironmentId, cwd: string) {
  return projectEnvironment.listEntries({ environmentId, input: { cwd } });
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: { cwd, relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH },
  });
}

export function setProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): void {
  appAtomRegistry.set(optimisticFileAtom(environmentId, cwd, relativePath), {
    confirmedAgainst: undefined,
    data: {
      relativePath,
      contents,
      byteLength: new TextEncoder().encode(contents).byteLength,
      truncated: false,
    },
  });
}

export function getOptimisticProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? null;
}

export function confirmProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): boolean {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimisticFile = appAtomRegistry.get(atom);
  if (optimisticFile?.data.contents !== contents) return false;

  const queryAtom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  const confirmed = {
    ...optimisticFile,
    confirmedAgainst: appAtomRegistry.get(queryAtom),
  };
  appAtomRegistry.set(atom, confirmed);
  appAtomRegistry.refresh(queryAtom);
  void executeAtomQuery(appAtomRegistry, queryAtom, {
    reportDefect: false,
    reportFailure: false,
  }).then((result) => {
    if (result._tag === "Success" && appAtomRegistry.get(atom) === confirmed) {
      appAtomRegistry.set(atom, null);
    }
  });
  return true;
}

export function resolveProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  data: ProjectReadFileResult | null,
): ProjectReadFileResult | null {
  if (relativePath === null) return data;
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? data;
}

export function clearProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): void {
  appAtomRegistry.set(optimisticFileAtom(environmentId, cwd, relativePath), null);
}

function errorMessage<A>(result: AsyncResult.AsyncResult<A, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const cause = Cause.squash(result.cause);
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
): ProjectQueryState<ProjectListEntriesResult> {
  const atom = getProjectEntriesQueryAtom(environmentId, cwd);
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}

/**
 * Backing query for the project file picker: a debounced, bounded, file-only
 * server search. An empty query is a valid request — the index answers it
 * with frecency-ordered files, so the picker's initial view is recent files
 * without transferring the full workspace listing. `matchedQuery` is the
 * query the returned entries were computed for, so the caller can highlight
 * against results instead of half-typed input.
 */
export function useProjectFilePickerQuery(
  environmentId: EnvironmentId,
  cwd: string,
  query: string,
  limit: number,
  options?: { readonly imageOnly?: boolean },
) {
  const search = useProjectPathSearch(
    {
      environmentId,
      cwd,
      query,
      kind: "file",
      ...(options?.imageOnly ? { imageOnly: true } : {}),
    },
    limit,
    { allowEmptyQuery: true },
  );

  return {
    entries: search.isPending ? [] : search.entries,
    error: search.error,
    isPending: search.isPending,
    matchedQuery: search.searchedQuery,
  };
}

export function useProjectFileQuery(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  enabled = true,
): ProjectQueryState<ProjectReadFileResult> {
  const atom = enabled
    ? getProjectFileQueryAtom(environmentId, cwd, relativePath)
    : EMPTY_PROJECT_FILE_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  const data = Option.getOrNull(AsyncResult.value(result));
  const optimisticResult = useAtomValue(
    optimisticFileAtom(environmentId, cwd, relativePath ?? EMPTY_PROJECT_FILE_PATH),
  );
  const optimisticFile = relativePath === null ? null : optimisticResult;

  return {
    data: optimisticFile?.data ?? data,
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}
