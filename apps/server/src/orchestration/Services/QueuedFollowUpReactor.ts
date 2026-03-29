import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface QueuedFollowUpReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class QueuedFollowUpReactor extends ServiceMap.Service<
  QueuedFollowUpReactor,
  QueuedFollowUpReactorShape
>()("t3/orchestration/Services/QueuedFollowUpReactor") {}
