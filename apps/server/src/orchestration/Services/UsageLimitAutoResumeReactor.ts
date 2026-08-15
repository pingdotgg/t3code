import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface UsageLimitAutoResumeReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class UsageLimitAutoResumeReactor extends Context.Service<
  UsageLimitAutoResumeReactor,
  UsageLimitAutoResumeReactorShape
>()("t3/orchestration/Services/UsageLimitAutoResumeReactor") {}
