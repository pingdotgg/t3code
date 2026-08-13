/** Resolve and materialize the per-repository worktrees for an isolated thread. */
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveAnchorRepoRoot } from "@t3tools/shared/git";
import {
  createThreadWorktrees,
  type CreatedThreadWorktree,
  type WorktreeFanoutTarget,
} from "./WorktreeFanout.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export interface ThreadWorktreeBootstrapResult {
  readonly created: ReadonlyArray<CreatedThreadWorktree>;
  readonly worktrees: ReadonlyArray<{ readonly repoRoot: string; readonly worktreePath: string }>;
  readonly worktreePath: string | null;
  readonly branch: string;
}

interface ThreadWorktreeBootstrapInput {
  readonly worktreesDir: string;
  readonly projectId: ProjectId | undefined;
  readonly threadId: ThreadId;
  readonly prepare: {
    readonly projectCwd: string;
    readonly baseBranch: string;
    readonly branch?: string | null | undefined;
    readonly startFromOrigin?: boolean | undefined;
  };
}

export const prepareThreadWorktreeFanout = Effect.fn("prepareThreadWorktreeFanout")(function* (
  input: ThreadWorktreeBootstrapInput,
) {
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const projectId =
    input.projectId ??
    (yield* projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.map((shell) => (Option.isSome(shell) ? shell.value.projectId : undefined))));
  const project = projectId
    ? yield* projectionSnapshotQuery
        .getProjectShellById(projectId)
        .pipe(Effect.map(Option.getOrUndefined))
    : undefined;
  const repoRoots = project?.repoRoots?.length ? project.repoRoots : [input.prepare.projectCwd];
  const anchorRepoRoot = resolveAnchorRepoRoot({
    workspaceRoot: input.prepare.projectCwd,
    repoRoots,
  });

  let anchorBaseRef = input.prepare.baseBranch;
  const startFromOrigin =
    input.prepare.startFromOrigin === true &&
    (yield* gitWorkflow.remoteExists({ cwd: anchorRepoRoot, remoteName: "origin" }));
  if (startFromOrigin) {
    yield* gitWorkflow.fetchRemote({ cwd: anchorRepoRoot, remoteName: "origin" });
    const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
      cwd: anchorRepoRoot,
      refName: input.prepare.baseBranch,
      fallbackRemoteName: "origin",
    });
    anchorBaseRef = resolvedRemoteBase.commitSha;
  }

  const targets = yield* Effect.forEach(
    repoRoots,
    (repoRoot): Effect.Effect<WorktreeFanoutTarget> =>
      repoRoot === anchorRepoRoot
        ? Effect.succeed({
            repoRoot,
            baseRef: anchorBaseRef,
            newBranch: input.prepare.branch ?? null,
          })
        : gitWorkflow.localStatus({ cwd: repoRoot }).pipe(
            Effect.map((status) => status.refName ?? "HEAD"),
            Effect.orElseSucceed(() => "HEAD"),
            Effect.map((baseRef) => ({
              repoRoot,
              baseRef,
              newBranch: input.prepare.branch ?? null,
            })),
          ),
  );
  const created = yield* createThreadWorktrees({
    worktreesDir: input.worktreesDir,
    projectId: projectId ?? input.threadId,
    threadId: input.threadId,
    targets,
  });
  const anchorWorktree = created.find((entry) => entry.repoRoot === anchorRepoRoot) ?? created[0];
  return {
    created,
    worktrees: created.map((entry) => ({
      repoRoot: entry.repoRoot,
      worktreePath: entry.worktreePath,
    })),
    worktreePath: anchorWorktree?.worktreePath ?? null,
    branch: anchorWorktree?.refName ?? input.prepare.branch ?? input.prepare.baseBranch,
  };
});
