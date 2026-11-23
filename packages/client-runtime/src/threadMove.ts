import {
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ProjectId,
  type RepositoryIdentity,
  type ThreadMoveGit,
} from "@t3tools/contracts";

interface MoveProject {
  readonly id: ProjectId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

/** The target's project for the same repository, when exactly one matches. */
export function findMoveTargetProject<P extends MoveProject>(
  source: MoveProject | null | undefined,
  targetProjects: ReadonlyArray<P>,
): P | null {
  const identity = source?.repositoryIdentity;
  if (identity == null) return null;
  const key = repositoryGroupingKeyOf(identity).toLowerCase();
  const matches = targetProjects.filter(
    (project) =>
      project.repositoryIdentity != null &&
      repositoryGroupingKeyOf(project.repositoryIdentity).toLowerCase() === key,
  );
  return matches.length === 1 ? matches[0]! : null;
}

/** What happens to the thread's code, for the move dialog to describe. */
export type ThreadMoveCodeSummary =
  | { readonly type: "no-git" }
  | {
      readonly type: "carries";
      readonly branch: string;
      readonly unpushedCommitCount: number;
      readonly uncommittedFileCount: number;
    }
  | { readonly type: "not-pushed"; readonly branch: string; readonly uncommittedFileCount: number };

export function summarizeThreadMoveCode(git: ThreadMoveGit | null): ThreadMoveCodeSummary {
  if (git === null) return { type: "no-git" };
  if (git.remoteBranch === null) {
    return {
      type: "not-pushed",
      branch: git.branch,
      uncommittedFileCount: git.uncommittedFileCount,
    };
  }
  return {
    type: "carries",
    branch: git.branch,
    unpushedCommitCount: git.unpushedCommitCount,
    uncommittedFileCount: git.uncommittedFileCount,
  };
}

/** Environments a thread can move to: connected, other than its own, and allowed to start threads. */
export function threadMoveTargets<E extends { readonly environmentId: EnvironmentId }>(
  sourceEnvironmentId: EnvironmentId,
  environments: ReadonlyArray<E>,
  canOperate: (environmentId: EnvironmentId) => boolean,
): ReadonlyArray<E> {
  return environments.filter(
    (environment) =>
      environment.environmentId !== sourceEnvironmentId && canOperate(environment.environmentId),
  );
}
