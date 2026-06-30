import type { StepRunId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface CapturedStepOutputReadInput {
  readonly stepRunId: StepRunId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

export interface CapturedStepOutputReaderShape {
  readonly read: (
    input: CapturedStepOutputReadInput,
  ) => Effect.Effect<unknown | undefined, WorkflowEventStoreError>;
}

export class CapturedStepOutputReader extends Context.Service<
  CapturedStepOutputReader,
  CapturedStepOutputReaderShape
>()("t3/workflow/Services/CapturedStepOutputReader") {}
