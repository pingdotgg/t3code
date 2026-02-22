import type { OrchestrationEvent } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface OrchestrationEventRepositoryShape {
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent>;
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Effect.Effect<OrchestrationEvent[]>;
  readonly readAll: () => Effect.Effect<OrchestrationEvent[]>;
  readonly close: () => void;
}

export class OrchestrationEventRepository extends Context.Tag("orchestration/EventRepository")<
  OrchestrationEventRepository,
  OrchestrationEventRepositoryShape
>() {}
