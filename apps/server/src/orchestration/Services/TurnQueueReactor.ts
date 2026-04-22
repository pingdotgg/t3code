import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface TurnQueueReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class TurnQueueReactor extends Context.Service<TurnQueueReactor, TurnQueueReactorShape>()(
  "harness/orchestration/Services/TurnQueueReactor",
) {}
