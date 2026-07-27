import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:BatchEnableStandards`.
 *
 * Enables (subscribes the account to) one or more security standards.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.BatchEnableStandardsHttp)`.
 * @binding
 * @section Standards & Controls
 * @example Enable a Standard
 * ```typescript
 * // init — account-level binding, no resource argument
 * const batchEnableStandards = yield* AWS.SecurityHub.BatchEnableStandards();
 *
 * // runtime
 * yield* batchEnableStandards({
 *   StandardsSubscriptionRequests: [{ StandardsArn: standardsArn }],
 * });
 * ```
 */
export interface BatchEnableStandards extends Binding.Service<
  BatchEnableStandards,
  "AWS.SecurityHub.BatchEnableStandards",
  () => Effect.Effect<
    (
      request?: securityhub.BatchEnableStandardsRequest,
    ) => Effect.Effect<
      securityhub.BatchEnableStandardsResponse,
      securityhub.BatchEnableStandardsError
    >
  >
> {}
export const BatchEnableStandards = Binding.Service<BatchEnableStandards>(
  "AWS.SecurityHub.BatchEnableStandards",
);
