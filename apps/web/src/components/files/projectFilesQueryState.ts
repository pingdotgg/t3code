import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProjectListEntriesResult,
  ProjectReadFileError,
  type ProjectReadFileResult,
  T3_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import { fileContentRevision } from "@t3tools/shared/fileContentRevision";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { revisionedQuery } from "~/state/revisionedQuery";

const EMPTY_PROJECT_FILE_PATH = "";
const EMPTY_PROJECT_ENTRIES_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectListEntriesResult, never>(false),
);
const EMPTY_PROJECT_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("project-file-query:empty"));
export function optimisticFileAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
) {
  return projectEnvironment.optimisticFile({ environmentId, cwd, relativePath });
}

// Dirty contents must survive a closed preview, including failed or unauthorized saves.
const unsavedFileMounts = new Map<ReturnType<typeof optimisticFileAtom>, () => void>();

function releaseUnsavedFile(atom: ReturnType<typeof optimisticFileAtom>): void {
  const unmount = unsavedFileMounts.get(atom);
  unsavedFileMounts.delete(atom);
  unmount?.();
}

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

interface ProjectFileQueryState extends ProjectQueryState<ProjectReadFileResult> {
  readonly readError: ProjectReadFileError | null;
  readonly isNotFile: boolean;
  readonly isFile: boolean;
  readonly conflict: boolean;
}

function getProjectEntriesQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
) {
  return projectEnvironment.listEntries({
    environmentId,
    input: { cwd, ...(directoryPath !== undefined ? { directoryPath } : {}) },
  });
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: {
      cwd,
      relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH,
      ...(relativePath === T3_PROJECT_FILE_NAME ? { allowMissing: true } : {}),
    },
  });
}

export function setProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  if (!unsavedFileMounts.has(atom)) {
    unsavedFileMounts.set(atom, appAtomRegistry.mount(atom));
  }
  const current = appAtomRegistry.get(atom);
  appAtomRegistry.set(atom, {
    saved: false,
    ...(current === null
      ? baseRevisionOf(readProjectFileData(environmentId, cwd, relativePath))
      : current.saved
        ? { baseRevision: fileContentRevision(current.data.contents) }
        : {
            ...(current.baseRevision !== undefined ? { baseRevision: current.baseRevision } : {}),
            ...(current.conflict ? { conflict: true } : {}),
          }),
    data: {
      relativePath,
      contents,
      byteLength: new TextEncoder().encode(contents).byteLength,
      truncated: false,
    },
  });
}

function readProjectFileData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | undefined {
  const result = appAtomRegistry.get(getProjectFileQueryAtom(environmentId, cwd, relativePath));
  return Option.getOrUndefined(AsyncResult.value(result));
}

function baseRevisionOf(data: ProjectReadFileResult | undefined): { baseRevision?: string } {
  return data && data.exists !== false && !data.truncated
    ? { baseRevision: fileContentRevision(data.contents) }
    : {};
}

export function getOptimisticProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? null;
}

export function getProjectFileContents(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): string | undefined {
  const optimistic = getOptimisticProjectFileQueryData(environmentId, cwd, relativePath);
  if (optimistic) return optimistic.contents;
  const data = readProjectFileData(environmentId, cwd, relativePath);
  return data?.exists === false ? undefined : data?.contents;
}

export function getUnsavedProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  const optimistic = appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath));
  return !optimistic?.saved ? (optimistic?.data ?? null) : null;
}

export function getProjectFileBaseRevision(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): string | undefined {
  const optimistic = appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath));
  return optimistic?.saved === false ? optimistic.baseRevision : undefined;
}

export function isProjectFileConflicted(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): boolean {
  const optimistic = appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath));
  return optimistic?.saved === false && optimistic.conflict === true;
}

/** Holds the draft back from autosave until the user keeps or discards it. */
export function markProjectFileConflict(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimistic = appAtomRegistry.get(atom);
  if (optimistic?.saved !== false) return;
  appAtomRegistry.set(atom, { ...optimistic, conflict: true });
  appAtomRegistry.refresh(getProjectFileQueryAtom(environmentId, cwd, relativePath));
}

/** The next write replaces whatever the host has. */
export function keepProjectFileDraft(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): string | null {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimistic = appAtomRegistry.get(atom);
  if (optimistic?.saved !== false) return null;
  appAtomRegistry.set(atom, { saved: false, data: optimistic.data });
  return optimistic.data.contents;
}

export function confirmProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): boolean {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimisticFile = appAtomRegistry.get(atom);
  if (optimisticFile?.data.contents !== contents) {
    // Newer edits are now based on what this write put on the host.
    if (optimisticFile?.saved === false && !optimisticFile.conflict) {
      appAtomRegistry.set(atom, { ...optimisticFile, baseRevision: fileContentRevision(contents) });
    }
    return false;
  }

  const queryAtom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  appAtomRegistry.set(atom, {
    ...optimisticFile,
    saved: true,
    confirmingQuery: queryAtom,
  });
  releaseUnsavedFile(atom);
  appAtomRegistry.refresh(queryAtom);
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
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  appAtomRegistry.set(atom, null);
  releaseUnsavedFile(atom);
}

export function discardProjectFileDraft(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): void {
  clearProjectFileQueryData(environmentId, cwd, relativePath);
  appAtomRegistry.refresh(getProjectFileQueryAtom(environmentId, cwd, relativePath));
}

function failureCause<A>(result: AsyncResult.AsyncResult<A, unknown>): unknown {
  return result._tag === "Failure" ? Cause.squash(result.cause) : null;
}

function errorMessage(cause: unknown): string | null {
  if (cause === null) return null;
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

const isProjectReadFileError = Schema.is(ProjectReadFileError);

/** `revision` is the workspace mutation id; a new one refetches the listing. */
export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
  revision?: string | null,
): ProjectQueryState<ProjectListEntriesResult> {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const atom = canReadFiles
    ? getProjectEntriesQueryAtom(environmentId, cwd, directoryPath)
    : EMPTY_PROJECT_ENTRIES_QUERY_ATOM;
  const result = useAtomValue(revisionedQuery(atom, canReadFiles ? revision : undefined));
  const refreshAtom = useAtomRefresh(atom);
  const refresh = () => refreshAtom();
  return {
    data: AsyncResult.getOrElse(result, () => null),
    error: fileAccess.isPending
      ? null
      : canReadFiles
        ? errorMessage(failureCause(result))
        : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: fileAccess.isPending || result.waiting,
    refresh,
  };
}

/** Empty queries return frecency-ranked files without transferring the full workspace listing. */
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
): ProjectFileQueryState {
  // Read media-like paths too; a failed read is how folders with those names are detected.
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const isQueryEnabled = enabled;
  const atom =
    enabled && canReadFiles
      ? getProjectFileQueryAtom(environmentId, cwd, relativePath)
      : EMPTY_PROJECT_FILE_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = () => refreshAtom();
  const readData = AsyncResult.getOrElse(result, () => null);
  const isMissing = readData?.exists === false;
  const optimisticResult = useAtomValue(
    optimisticFileAtom(environmentId, cwd, relativePath ?? EMPTY_PROJECT_FILE_PATH),
  );
  const optimisticFile = relativePath === null ? null : optimisticResult;
  const cause = failureCause(result);
  const readError = isProjectReadFileError(cause) ? cause : null;
  const data = canReadFiles ? (optimisticFile?.data ?? (isMissing ? null : readData)) : null;
  const isNotFile = readError?.failure === "path_not_file";

  return {
    data,
    error:
      !isQueryEnabled || fileAccess.isPending
        ? null
        : canReadFiles
          ? isMissing && !optimisticFile
            ? `'${relativePath}' does not exist.`
            : errorMessage(cause)
          : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: isQueryEnabled && (fileAccess.isPending || result.waiting),
    readError,
    isNotFile,
    // A folder error overrides cached contents retained across failed refreshes.
    isFile: !isNotFile && (data !== null || readError?.failure === "binary_file"),
    conflict: canReadFiles && optimisticFile?.saved === false && optimisticFile.conflict === true,
    refresh,
  };
}
