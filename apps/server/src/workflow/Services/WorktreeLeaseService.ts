import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface Lease {
  readonly fenceToken: number;
}

export interface WorktreeLeaseServiceShape {
  readonly acquire: (
    worktreeRef: string,
    ownerKind: "step" | "user",
    ownerId: string,
  ) => Effect.Effect<Lease, WorkflowEventStoreError>;
  readonly release: (
    worktreeRef: string,
    fenceToken: number,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly isValid: (
    worktreeRef: string,
    fenceToken: number,
  ) => Effect.Effect<boolean, WorkflowEventStoreError>;
}

export class WorktreeLeaseService extends Context.Service<
  WorktreeLeaseService,
  WorktreeLeaseServiceShape
>()("t3/workflow/Services/WorktreeLeaseService") {}
