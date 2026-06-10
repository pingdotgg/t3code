import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface QueuedTurnReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class QueuedTurnReactor extends Context.Service<QueuedTurnReactor, QueuedTurnReactorShape>()(
  "t3/orchestration/Services/QueuedTurnReactor",
) {}
