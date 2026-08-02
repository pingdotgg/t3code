import type * as shield from "@distilled.cloud/aws/shield";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `shield:DescribeAttack`.
 *
 * Hydrates the full detail document of a DDoS attack (vectors, counters,
 * mitigations, sub-resources) from an attack id surfaced by
 * {@link ListAttacks}. Requires an active Shield Advanced subscription; a
 * nonexistent attack id answers with an empty document or the typed
 * `AccessDeniedException`.
 * Provide the implementation with
 * `Effect.provide(AWS.Shield.DescribeAttackHttp)`.
 * @binding
 * @section Attack Visibility
 * @example Hydrate Attack Details
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeAttack = yield* AWS.Shield.DescribeAttack();
 *
 * // runtime
 * const { Attack } = yield* describeAttack({ AttackId: attackId });
 * ```
 */
export interface DescribeAttack extends Binding.Service<
  DescribeAttack,
  "AWS.Shield.DescribeAttack",
  () => Effect.Effect<
    (
      request: shield.DescribeAttackRequest,
    ) => Effect.Effect<
      shield.DescribeAttackResponse,
      shield.DescribeAttackError
    >
  >
> {}
export const DescribeAttack = Binding.Service<DescribeAttack>(
  "AWS.Shield.DescribeAttack",
);
