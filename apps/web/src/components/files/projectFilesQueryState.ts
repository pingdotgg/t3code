import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProjectListEntriesResult,
  ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";

const PROJECT_QUERY_STALE_TIME_MS = 30_000;
const PROJECT_QUERY_IDLE_TTL_MS = 5 * 60_000;
const EMPTY_PROJECT_FILE_PATH = "";

class ProjectQueryError extends Data.TaggedError("ProjectQueryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function queryError(message: string, cause: unknown): ProjectQueryError {
  return new ProjectQueryError({ message, cause });
}

function entriesKey(environmentId: EnvironmentId, cwd: string): string {
  return [environmentId, cwd].map(encodeURIComponent).join("|");
}

function fileKey(environmentId: EnvironmentId, cwd: string, relativePath: string): string {
  return [environmentId, cwd, relativePath].map(encodeURIComponent).join("|");
}

function keyParts(key: string): string[] {
  return key.split("|").map(decodeURIComponent);
}

const projectEntriesQueryAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.tryPromise({
      try: () => {
        const [environmentId, cwd] = keyParts(key) as [EnvironmentId, string];
        return ensureEnvironmentApi(environmentId).projects.listEntries({ cwd });
      },
      catch: (cause) => queryError("Could not load workspace files.", cause),
    }),
  ).pipe(
    Atom.swr({
      staleTime: PROJECT_QUERY_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PROJECT_QUERY_IDLE_TTL_MS),
    Atom.withLabel(`projects:entries:${key}`),
  ),
);

const projectFileQueryAtom = Atom.family((key: string) =>
  Atom.make(
    Effect.tryPromise({
      try: () => {
        const [environmentId, cwd, relativePath] = keyParts(key) as [EnvironmentId, string, string];
        if (relativePath === EMPTY_PROJECT_FILE_PATH) return Promise.resolve(null);
        return ensureEnvironmentApi(environmentId).projects.readFile({ cwd, relativePath });
      },
      catch: (cause) => queryError("Could not read workspace file.", cause),
    }),
  ).pipe(
    Atom.swr({
      staleTime: PROJECT_QUERY_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PROJECT_QUERY_IDLE_TTL_MS),
    Atom.withLabel(`projects:file:${key}`),
  ),
);

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function getProjectEntriesQueryAtom(environmentId: EnvironmentId, cwd: string) {
  return projectEntriesQueryAtom(entriesKey(environmentId, cwd));
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  return projectFileQueryAtom(fileKey(environmentId, cwd, relativePath ?? EMPTY_PROJECT_FILE_PATH));
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
  const refresh = useCallback(() => appAtomRegistry.refresh(atom), [atom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}

export function useProjectFileQuery(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
): ProjectQueryState<ProjectReadFileResult> {
  const atom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  const result = useAtomValue(atom);
  const refresh = useCallback(() => appAtomRegistry.refresh(atom), [atom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}
