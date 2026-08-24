import type * as shield from "@distilled.cloud/aws/shield";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `shield:ListAttacks`.
 *
 * Lists all ongoing DDoS attacks, or all attacks in a given time window,
 * optionally filtered to specific protected-resource ARNs — the entry point
 * for a security dashboard or attack-alerting handler. Requires an active
 * Shield Advanced subscription.
 * Provide the implementation with `Effect.provide(AWS.Shield.ListAttacksHttp)`.
 * @binding
 * @section Attack Visibility
 * @example List Ongoing Attacks
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listAttacks = yield* AWS.Shield.ListAttacks();
 *
 * // runtime — omitting the time range returns ongoing attacks
 * const { AttackSummaries } = yield* listAttacks();
 * ```
 */
export interface ListAttacks extends Binding.Service<
  ListAttacks,
  "AWS.Shield.ListAttacks",
  () => Effect.Effect<
    (
      request?: shield.ListAttacksRequest,
    ) => Effect.Effect<shield.ListAttacksResponse, shield.ListAttacksError>
  >
> {}
export const ListAttacks = Binding.Service<ListAttacks>(
  "AWS.Shield.ListAttacks",
);
