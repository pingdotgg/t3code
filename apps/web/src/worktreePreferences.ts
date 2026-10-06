import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "./hooks/useLocalStorage";

const LastWorktreeBaseBranch = Schema.NullOr(Schema.String);

/** Remembers explicit base selections independently of the draft that used them. */
export function useLastWorktreeBaseBranch(projectRef: ScopedProjectRef | null) {
  return useLocalStorage(
    `t3code:last-worktree-base:${projectRef ? scopedProjectKey(projectRef) : "none"}`,
    null,
    LastWorktreeBaseBranch,
  );
}
