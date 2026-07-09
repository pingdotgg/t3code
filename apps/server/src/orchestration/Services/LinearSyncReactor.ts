import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * LinearSyncReactor - background service that writes T3 Code thread progress
 * back to linked Linear issues (In Progress on start → In Review on PR open →
 * Done on merge).
 */
export class LinearSyncReactor extends Context.Service<
  LinearSyncReactor,
  {
    /** Start reacting to lifecycle + VCS signals. Must be run in a scope. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration/Services/LinearSyncReactor") {}
