import type * as eventbridge from "@distilled.cloud/aws/eventbridge";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListReplaysRequest extends eventbridge.ListReplaysRequest {}

/**
 * Lists the event replays in the account (`events:ListReplays`).
 *
 * Bind this operation inside a function runtime to enumerate replays,
 * optionally filtered by name prefix, state, or source archive. Provide the
 * `ListReplaysHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Replaying Events
 * @example List Running Replays
 * ```typescript
 * // init — bind the operation (provide AWS.EventBridge.ListReplaysHttp on the Function)
 * const listReplays = yield* AWS.EventBridge.ListReplays();
 *
 * // runtime — enumerate replays currently running
 * const { Replays } = yield* listReplays({ State: "RUNNING" });
 * ```
 */
export interface ListReplays extends Binding.Service<
  ListReplays,
  "AWS.EventBridge.ListReplays",
  () => Effect.Effect<
    (
      request?: ListReplaysRequest,
    ) => Effect.Effect<
      eventbridge.ListReplaysResponse,
      eventbridge.ListReplaysError
    >
  >
> {}
export const ListReplays = Binding.Service<ListReplays>(
  "AWS.EventBridge.ListReplays",
);
