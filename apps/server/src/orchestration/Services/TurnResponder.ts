/**
 * TurnResponder - which model an in-flight turn is running on.
 *
 * `ProviderCommandReactor` is the only place that knows the model selection a
 * turn actually starts with, including the concrete effort the auto-effort
 * reviewer picked. Provider runtime events arrive later, on a different path,
 * so the reactor parks that selection here and `ProviderRuntimeIngestion` reads
 * it back when an assistant message completes.
 *
 * A turn has no id until the provider reports one, so the reactor parks the
 * selection per thread and ingestion binds it to the turn the provider started.
 * Reads are then scoped by turn: a straggling completion for a superseded turn
 * must not be labelled with the model a newer turn is running on.
 *
 * State is per-thread and in memory: it exists only to label messages produced
 * by recent turns. A restart mid-turn simply leaves that message unlabeled.
 *
 * @module TurnResponder
 */
import type { OrchestrationMessageResponder, ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface TurnResponderShape {
  /** Park the selection a turn is starting with, before its turn id exists. */
  readonly record: (input: {
    readonly threadId: ThreadId;
    readonly responder: OrchestrationMessageResponder;
  }) => Effect.Effect<void>;
  /** Attach the parked selection to the turn the provider reported starting. */
  readonly bind: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<void>;
  /**
   * Selection a turn ran on. Falls back to the parked selection only while no
   * turn on the thread has been bound, which is how providers that never report
   * a usable turn id still get their messages labelled.
   */
  readonly get: (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
  }) => Effect.Effect<OrchestrationMessageResponder | undefined>;
}

export class TurnResponder extends Context.Service<TurnResponder, TurnResponderShape>()(
  "t3/orchestration/Services/TurnResponder",
) {}
