import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ProjectCloneSnapshot,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProject, subscribeProject } from "~/state/entities";
import { environmentProjectClonesAtom } from "~/state/projectClones";

export interface WaitForCloneAndAssignDeps {
  readonly readClone: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => ProjectCloneSnapshot | null;
  readonly subscribeClone: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    listener: (clone: ProjectCloneSnapshot | null) => void,
  ) => () => void;
  readonly readProject: (ref: ScopedProjectRef) => EnvironmentProject | null;
  readonly subscribeProject: (
    ref: ScopedProjectRef,
    listener: (project: EnvironmentProject | null) => void,
  ) => () => void;
  readonly cloneTimeoutMs?: number;
  readonly identityTimeoutMs?: number;
}

const defaultDeps: WaitForCloneAndAssignDeps = {
  readClone: (environmentId, projectId) =>
    appAtomRegistry
      .get(environmentProjectClonesAtom(environmentId))
      .find((clone) => clone.projectId === projectId) ?? null,
  subscribeClone: (environmentId, projectId, listener) =>
    appAtomRegistry.subscribe(environmentProjectClonesAtom(environmentId), (clones) => {
      listener(clones.find((clone) => clone.projectId === projectId) ?? null);
    }),
  readProject,
  subscribeProject,
};

function waitForCloneDone(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  deps: WaitForCloneAndAssignDeps,
): Promise<boolean> {
  const existing = deps.readClone(environmentId, projectId);
  if (existing !== null && existing.phase !== "running") {
    return Promise.resolve(existing.phase === "done");
  }

  const timeoutMs = deps.cloneTimeoutMs ?? 15 * 60 * 1000;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let sawRunning = existing?.phase === "running";
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };
    const unsubscribe = deps.subscribeClone(environmentId, projectId, (clone) => {
      if (clone === null) {
        if (sawRunning) {
          // A pruned tracker entry counts as success only if the cloned project still exists
          // (discarded/cancelled clones remove the project as well as the tracker entry).
          const projectStillExists =
            deps.readProject(scopeProjectRef(environmentId, projectId)) !== null;
          finish(projectStillExists);
        }
        return;
      }
      if (clone.phase === "running") {
        sawRunning = true;
        return;
      }
      finish(clone.phase === "done");
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function waitForRepositoryIdentity(
  projectRef: ScopedProjectRef,
  deps: WaitForCloneAndAssignDeps,
): Promise<EnvironmentProject | null> {
  const current = deps.readProject(projectRef);
  if (current === null) {
    return Promise.resolve(null);
  }
  if (current.repositoryIdentity != null) {
    return Promise.resolve(current);
  }
  const timeoutMs = deps.identityTimeoutMs ?? 10_000;
  return new Promise<EnvironmentProject | null>((resolve) => {
    let settled = false;
    let latest: EnvironmentProject | null = current;
    const finish = (project: EnvironmentProject | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(project);
    };
    const unsubscribe = deps.subscribeProject(projectRef, (project) => {
      latest = project;
      if (project === null) {
        finish(null);
        return;
      }
      if (project.repositoryIdentity != null) {
        finish(project);
      }
    });
    const timer = setTimeout(
      () => finish(latest?.repositoryIdentity != null ? latest : null),
      timeoutMs,
    );
  });
}

/**
 * Waits for an in-flight repository clone to succeed and resolve its repository identity
 * before assigning the cloned project to a team. Skips assignment if the clone fails, cancels,
 * or never resolves a repository identity.
 */
export async function waitForCloneAndAssignProject(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly assign: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    project: EnvironmentProject | null,
  ) => Promise<void>;
  readonly deps?: WaitForCloneAndAssignDeps;
}): Promise<boolean> {
  const deps = input.deps ?? defaultDeps;
  const cloneSucceeded = await waitForCloneDone(input.environmentId, input.projectId, deps);
  if (!cloneSucceeded) {
    return false;
  }
  const projectRef = scopeProjectRef(input.environmentId, input.projectId);
  const project = await waitForRepositoryIdentity(projectRef, deps);
  if (project === null || project.repositoryIdentity == null) {
    return false;
  }
  await input.assign(input.environmentId, input.projectId, project);
  return true;
}
