import type { EnvironmentId } from "@t3tools/contracts";
import { defaultWorktreeBaseRef } from "@t3tools/client-runtime/scheduled-task-base-ref";

import { usePaginatedBranches } from "../../state/queries";

/**
 * The base branch a worktree task saves: the chosen one, else `main`, or the
 * repo's default branch when it has no `main`. `pending` holds saving until
 * that can be told.
 */
export function useScheduledTaskBaseRef(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly chosen: string;
  readonly worktree: boolean;
}) {
  const cwd = input.worktree && !input.chosen ? input.cwd : null;
  // The first page holds the current and default refs; `main` can sit past it.
  const topRefs = usePaginatedBranches({ environmentId: input.environmentId, cwd, query: "" });
  const mainRefs = usePaginatedBranches({ environmentId: input.environmentId, cwd, query: "main" });
  return {
    baseRef: input.chosen || defaultWorktreeBaseRef([...mainRefs.refs, ...topRefs.refs]),
    pending:
      (topRefs.isPending && topRefs.data === null) ||
      (mainRefs.isPending && mainRefs.data === null),
  };
}
