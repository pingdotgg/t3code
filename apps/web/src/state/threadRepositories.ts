import {
  collectEditedFilePaths,
  threadRepositoriesTarget,
} from "@t3tools/client-runtime/state/thread-repositories";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ScopedThreadRef,
  WorkspaceListRepositoriesResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readThreadShell, useProject, useQuietThreadShell } from "./entities";
import { useEnvironmentQuery } from "./query";
import { environmentThreadDetails } from "./threads";
import { workspaceRepositoryEnvironment } from "./workspaceRepositories";

/**
 * The repos and reference folders a thread works in. Null for projects without tracked
 * folders, which work in their home folder only and make no request.
 */
export function useWorkspaceRepositories(
  input: {
    readonly environmentId: EnvironmentId;
    readonly project: EnvironmentProject | null;
    readonly worktreePath: string | null;
  } | null,
): WorkspaceListRepositoriesResult | null {
  const target = input === null ? null : threadRepositoriesTarget(input);
  return useEnvironmentQuery(
    target === null ? null : workspaceRepositoryEnvironment.repositories(target),
  ).data;
}

export function useThreadWorkspaceRepositories(
  threadRef: ScopedThreadRef | null,
): WorkspaceListRepositoriesResult | null {
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(
    thread === null ? null : { environmentId: thread.environmentId, projectId: thread.projectId },
  );
  return useWorkspaceRepositories(
    thread === null
      ? null
      : { environmentId: thread.environmentId, project, worktreePath: thread.worktreePath },
  );
}

/** The last loaded repo list, for click handlers; null until a view has asked for it. */
export function readThreadWorkspaceRepositories(
  threadRef: ScopedThreadRef,
): WorkspaceListRepositoriesResult | null {
  const thread = readThreadShell(threadRef);
  if (thread === null) return null;
  const target = threadRepositoriesTarget({
    environmentId: thread.environmentId,
    project: readProject({ environmentId: thread.environmentId, projectId: thread.projectId }),
    worktreePath: thread.worktreePath,
  });
  if (target === null) return null;
  return Option.getOrNull(
    AsyncResult.value(appAtomRegistry.get(workspaceRepositoryEnvironment.repositories(target))),
  );
}

/** Absolute paths the thread's loaded history reports editing, newest first. */
export function readThreadEditedFilePaths(threadRef: ScopedThreadRef): ReadonlyArray<string> {
  const projection = Option.getOrNull(
    appAtomRegistry.get(environmentThreadDetails.stateAtom(threadRef)).data,
  );
  return projection === null ? [] : collectEditedFilePaths(projection.turnItems);
}
