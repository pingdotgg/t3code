import { ThreadId, type ProjectId } from "@t3tools/contracts";

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
