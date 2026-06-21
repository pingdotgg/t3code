import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { ThreadShell } from "./types";

export function resolveSubagentParentThreadRef(
  thread: Pick<ThreadShell, "environmentId" | "parentRelation"> | null | undefined,
): ScopedThreadRef | null {
  if (!thread || thread.parentRelation?.kind !== "subagent") {
    return null;
  }
  return scopeThreadRef(thread.environmentId, thread.parentRelation.parentThreadId);
}
