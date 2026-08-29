import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ThreadSettlementReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  ThreadSettlementReactorShape
>()("t3/orchestration/Services/ThreadSettlementReactor") {}
