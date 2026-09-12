/**
 * ThreadBootstrap - Create-and-start sequence for a thread's first turn.
 *
 * Runs the `thread.turn.start` bootstrap: create the thread, prepare a
 * worktree, run the setup script, then dispatch the turn.
 *
 * @module ThreadBootstrap
 */
import type {
  OrchestrationClientOrigin,
  OrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type ThreadTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

export interface ThreadBootstrapShape {
  readonly dispatchTurnStart: (
    command: ThreadTurnStartCommand,
    options?: { readonly origin?: OrchestrationClientOrigin },
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

export class ThreadBootstrap extends Context.Service<ThreadBootstrap, ThreadBootstrapShape>()(
  "t3/orchestration/Services/ThreadBootstrap",
) {}
