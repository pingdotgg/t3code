import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:BatchGetFreeTrialInfo`.
 *
 * Gets free trial status for multiple Amazon Web Services accounts.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.BatchGetFreeTrialInfoHttp)`.
 * ### Account Settings & Usage
 * **Example:** Free Trial Status
 * ```typescript
 * // init
 * const batchGetFreeTrialInfo = yield* AWS.Inspector2.BatchGetFreeTrialInfo();
 *
 * // runtime
 * const { accounts } = yield* batchGetFreeTrialInfo({ accountIds: [accountId] });
 * ```
 *
 * @binding
 */
export interface BatchGetFreeTrialInfo extends Binding.Service<
  BatchGetFreeTrialInfo,
  "AWS.Inspector2.BatchGetFreeTrialInfo",
  () => Effect.Effect<
    (
      request: inspector2.BatchGetFreeTrialInfoRequest,
    ) => Effect.Effect<
      inspector2.BatchGetFreeTrialInfoResponse,
      inspector2.BatchGetFreeTrialInfoError
    >
  >
> {}
export const BatchGetFreeTrialInfo = Binding.Service<BatchGetFreeTrialInfo>(
  "AWS.Inspector2.BatchGetFreeTrialInfo",
);
