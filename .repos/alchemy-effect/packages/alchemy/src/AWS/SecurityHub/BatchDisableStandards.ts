import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:BatchDisableStandards`.
 *
 * Disables (unsubscribes the account from) one or more security standards.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.BatchDisableStandardsHttp)`.
 * @binding
 * @section Standards & Controls
 * @example Disable a Standard
 * ```typescript
 * // init — account-level binding, no resource argument
 * const batchDisableStandards = yield* AWS.SecurityHub.BatchDisableStandards();
 *
 * // runtime
 * yield* batchDisableStandards({
 *   StandardsSubscriptionArns: [subscriptionArn],
 * });
 * ```
 */
export interface BatchDisableStandards extends Binding.Service<
  BatchDisableStandards,
  "AWS.SecurityHub.BatchDisableStandards",
  () => Effect.Effect<
    (
      request?: securityhub.BatchDisableStandardsRequest,
    ) => Effect.Effect<
      securityhub.BatchDisableStandardsResponse,
      securityhub.BatchDisableStandardsError
    >
  >
> {}
export const BatchDisableStandards = Binding.Service<BatchDisableStandards>(
  "AWS.SecurityHub.BatchDisableStandards",
);
