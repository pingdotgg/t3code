import type { WorkflowEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface WorkflowProjectionPipelineShape {
  readonly projectEvent: (event: WorkflowEvent) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class WorkflowProjectionPipeline extends Context.Service<
  WorkflowProjectionPipeline,
  WorkflowProjectionPipelineShape
>()("t3/workflow/Services/WorkflowProjectionPipeline") {}
