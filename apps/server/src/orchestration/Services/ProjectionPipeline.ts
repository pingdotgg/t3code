import type { OrchestrationEvent } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { OrchestrationEventStoreError, ProjectionRepositoryError } from "../../persistence/Errors.ts";

export type OrchestrationProjectionPipelineError =
  | OrchestrationEventStoreError
  | ProjectionRepositoryError;

export interface OrchestrationProjectionPipelineShape {
  readonly bootstrap: Effect.Effect<void, OrchestrationProjectionPipelineError>;

  readonly projectEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class OrchestrationProjectionPipeline extends ServiceMap.Service<
  OrchestrationProjectionPipeline,
  OrchestrationProjectionPipelineShape
>()("orchestration/ProjectionPipeline") {}
