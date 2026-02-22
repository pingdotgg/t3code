import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface OrchestrationEngineShape {
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel>;
  readonly replayEvents: (fromSequenceExclusive: number) => Effect.Effect<OrchestrationEvent[]>;
  readonly dispatchUnknown: (command: unknown) => Effect.Effect<{ sequence: number }, Error>;
  readonly dispatch: (command: OrchestrationCommand) => Effect.Effect<{ sequence: number }, Error>;
  readonly subscribeToReadModel: (
    callback: (snapshot: OrchestrationReadModel) => void,
  ) => Effect.Effect<() => void>;
  readonly subscribeToDomainEvents: (
    callback: (event: OrchestrationEvent) => void,
  ) => Effect.Effect<() => void>;
}

export class OrchestrationEngineService extends Context.Tag("orchestration/Engine")<
  OrchestrationEngineService,
  OrchestrationEngineShape
>() {}
