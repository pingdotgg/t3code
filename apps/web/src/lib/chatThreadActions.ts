import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import type { DraftThreadEnvMode } from "../composerDraftStore";

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
    },
    // The opened draft's identity, which most callers have no use for.
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: ThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

export function resolveNewDraftStartFromOrigin(input: {
  envMode: DraftThreadEnvMode;
  newWorktreesStartFromOrigin: boolean;
}): boolean {
  return input.envMode === "worktree" && input.newWorktreesStartFromOrigin;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

export function resolveAvailableNewThreadProjectRef(input: {
  requested: ScopedProjectRef;
  members: ReadonlyArray<{
    environmentId: EnvironmentId;
    projectId: ProjectId;
    isPrimary?: boolean;
  }>;
  isEnvironmentReachable: (environmentId: EnvironmentId) => boolean;
}): ScopedProjectRef {
  if (input.isEnvironmentReachable(input.requested.environmentId)) {
    return input.requested;
  }
  const reachable = input.members
    .filter((member) => input.isEnvironmentReachable(member.environmentId))
    .toSorted((left, right) => Number(Boolean(right.isPrimary)) - Number(Boolean(left.isPrimary)));
  const next = reachable[0];
  return next ? scopeProjectRef(next.environmentId, next.projectId) : input.requested;
}

export function resolveWorkspaceOptionsAfterEnvironmentRetarget<
  TOptions extends {
    branch?: string | null;
    worktreePath?: string | null;
  },
>(input: {
  requestedEnvironmentId: EnvironmentId;
  targetEnvironmentId: EnvironmentId;
  options: TOptions | undefined;
}): TOptions | undefined {
  if (input.options === undefined) return undefined;
  if (input.requestedEnvironmentId === input.targetEnvironmentId) return input.options;
  return {
    ...input.options,
    ...(input.options.branch !== undefined ? { branch: null } : {}),
    ...(input.options.worktreePath !== undefined ? { worktreePath: null } : {}),
  };
}

// New threads inherit only the *project* from the current context. Branch,
// worktree, and env mode always come from the user's configured defaults —
// carrying them over from the viewed thread meant "new thread" silently
// reused checkouts and branches. Explicit affordances (branch toolbar's
// "new thread in this worktree") pass those options to handleNewThread
// directly instead.
export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef);
  return true;
}
