import type {
  OrchestrationGetFullThreadDiffStateInput,
  OrchestrationGetFullThreadDiffStateResult,
  OrchestrationGetTurnDiffFileDeltaInput,
  OrchestrationGetTurnDiffFileDeltaResult,
  OrchestrationGetTurnDiffStateInput,
  OrchestrationGetTurnDiffStateResult,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { CheckpointServiceError } from "../../checkpointing/Errors.ts";

export interface DiffStateQueryShape {
  readonly getTurnDiffState: (
    input: OrchestrationGetTurnDiffStateInput,
  ) => Effect.Effect<OrchestrationGetTurnDiffStateResult, CheckpointServiceError>;

  readonly getFullThreadDiffState: (
    input: OrchestrationGetFullThreadDiffStateInput,
  ) => Effect.Effect<OrchestrationGetFullThreadDiffStateResult, CheckpointServiceError>;

  readonly getTurnDiffFileDelta: (
    input: OrchestrationGetTurnDiffFileDeltaInput,
  ) => Effect.Effect<OrchestrationGetTurnDiffFileDeltaResult, CheckpointServiceError>;
}

export class DiffStateQuery extends Context.Service<DiffStateQuery, DiffStateQueryShape>()(
  "t3/diffState/Services/DiffStateQuery",
) {}
