/**
 * TurnResponder - which model an in-flight turn is running on.
 *
 * `ProviderCommandReactor` is the only place that knows the model selection a
 * turn actually starts with, including the concrete effort the auto-effort
 * reviewer picked. Provider runtime events arrive later, on a different path,
 * so the reactor parks that selection here and `ProviderRuntimeIngestion` reads
 * it back when an assistant message completes.
 *
 * State is per-thread and in memory: it exists only to label messages produced
 * by the current turn. A restart mid-turn simply leaves that message unlabeled.
 *
 * @module TurnResponder
 */
import type { OrchestrationMessageResponder, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface TurnResponderShape {
  readonly record: (input: {
    readonly threadId: ThreadId;
    readonly responder: OrchestrationMessageResponder;
  }) => Effect.Effect<void>;
  readonly get: (threadId: ThreadId) => Effect.Effect<OrchestrationMessageResponder | undefined>;
  readonly forget: (threadId: ThreadId) => Effect.Effect<void>;
}

export class TurnResponder extends Context.Service<TurnResponder, TurnResponderShape>()(
  "t3/orchestration/Services/TurnResponder",
) {}
