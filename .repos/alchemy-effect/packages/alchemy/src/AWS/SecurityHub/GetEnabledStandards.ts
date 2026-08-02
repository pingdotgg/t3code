import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:GetEnabledStandards`.
 *
 * Lists the standards subscriptions currently enabled in the account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.GetEnabledStandardsHttp)`.
 * @binding
 * @section Standards & Controls
 * @example List Enabled Standards
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getEnabledStandards = yield* AWS.SecurityHub.GetEnabledStandards();
 *
 * // runtime
 * const { StandardsSubscriptions } = yield* getEnabledStandards();
 * ```
 */
export interface GetEnabledStandards extends Binding.Service<
  GetEnabledStandards,
  "AWS.SecurityHub.GetEnabledStandards",
  () => Effect.Effect<
    (
      request?: securityhub.GetEnabledStandardsRequest,
    ) => Effect.Effect<
      securityhub.GetEnabledStandardsResponse,
      securityhub.GetEnabledStandardsError
    >
  >
> {}
export const GetEnabledStandards = Binding.Service<GetEnabledStandards>(
  "AWS.SecurityHub.GetEnabledStandards",
);
