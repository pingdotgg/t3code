import type { TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface WorktreeHandle {
  readonly repoRoot: string;
  readonly worktreeRef: string;
  readonly path: string;
  // Project identity for services that must resolve the project exactly
  // (path matching breaks under canonicalization, e.g. /tmp vs /private/tmp).
  readonly projectId?: string;
}

export interface WorktreePortShape {
  readonly ensureWorktree: (
    ticketId: TicketId,
  ) => Effect.Effect<WorktreeHandle, WorkflowEventStoreError>;
}

export class WorktreePort extends Context.Service<WorktreePort, WorktreePortShape>()(
  "t3/workflow/Services/WorktreePort",
) {}
