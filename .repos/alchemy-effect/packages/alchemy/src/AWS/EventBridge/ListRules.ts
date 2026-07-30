import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventBus } from "./EventBus.ts";

export interface ListRulesRequest extends Omit<
  eventbridge.ListRulesRequest,
  "EventBusName"
> {}

/**
 * Lists the rules on an EventBridge event bus (`events:ListRules`).
 *
 * Bind this operation to an {@link EventBus} inside a function runtime to get
 * a callable scoped to that bus; omit the bus argument to list rules on the
 * account's default bus. Provide the `ListRulesHttp` layer on the Function to
 * satisfy the binding.
 * @binding
 * @section Listing Rules
 * @example List Rules on a Bus
 * ```typescript
 * // init — bind the bus (provide AWS.EventBridge.ListRulesHttp on the Function)
 * const listRules = yield* AWS.EventBridge.ListRules(bus);
 *
 * // runtime — list rules, optionally filtered by name prefix
 * const { Rules } = yield* listRules({ NamePrefix: "orders-" });
 * ```
 */
export interface ListRules extends Binding.Service<
  ListRules,
  "AWS.EventBridge.ListRules",
  (
    bus?: EventBus,
  ) => Effect.Effect<
    (
      request?: ListRulesRequest,
    ) => Effect.Effect<
      eventbridge.ListRulesResponse,
      eventbridge.ListRulesError
    >
  >
> {}
export const ListRules = Binding.Service<ListRules>(
  "AWS.EventBridge.ListRules",
);
