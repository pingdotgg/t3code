import { ProjectId, ThreadId } from "@t3tools/contracts";

const LOCAL_CHECKOUT_SEGMENT = "local";

/**
 * Stable server-side owner for resources shared by every thread in a checkout.
 *
 * Environments are separate server processes, so project + checkout identity is
 * sufficient and gives every connected client the same owner without storing
 * renderer-local election state.
 */
export function worktreeResourceThreadId(
  projectId: ProjectId,
  worktreePath: string | null | undefined,
): ThreadId {
  const checkoutSegment =
    worktreePath && worktreePath.length > 0
      ? encodeURIComponent(worktreePath)
      : LOCAL_CHECKOUT_SEGMENT;
  return ThreadId.make(`worktree:${projectId}:${checkoutSegment}`);
}

const WORKTREE_RESOURCE_PREFIX = "worktree:";

export interface WorktreeResourceIdentity {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

/**
 * Inverse of worktreeResourceThreadId. Synthetic owner threads have no shell
 * entity, so checkout identity must be recoverable from the id alone for
 * worktree-scoped state to converge with sibling threads' shell-derived keys.
 */
export function parseWorktreeResourceThreadId(threadId: string): WorktreeResourceIdentity | null {
  if (!threadId.startsWith(WORKTREE_RESOURCE_PREFIX)) return null;
  const rest = threadId.slice(WORKTREE_RESOURCE_PREFIX.length);
  const separator = rest.lastIndexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  const projectId = rest.slice(0, separator);
  const checkoutSegment = rest.slice(separator + 1);
  if (checkoutSegment === LOCAL_CHECKOUT_SEGMENT) {
    return { projectId: ProjectId.make(projectId), worktreePath: null };
  }
  try {
    return {
      projectId: ProjectId.make(projectId),
      worktreePath: decodeURIComponent(checkoutSegment),
    };
  } catch {
    return null;
  }
}

/** Scope a checkout to its environment; branches may have identical paths on different hosts. */
export function worktreeScopeKey(
  environmentId: string,
  projectId: ProjectId,
  worktreePath: string | null | undefined,
): string {
  return JSON.stringify([environmentId, projectId, worktreePath || null]);
}
