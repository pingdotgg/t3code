import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface QueuedFollowUpReactorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class QueuedFollowUpReactor extends Context.Service<
  QueuedFollowUpReactor,
  QueuedFollowUpReactorShape
>()("t3/orchestration/Services/QueuedFollowUpReactor") {}
