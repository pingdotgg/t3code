import type * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetResourcePolicy` operation (IAM action
 * `cloudhsm:GetResourcePolicy`).
 *
 * Reads the resource policy attached to a CloudHSM backup (backups are the
 * only CloudHSM resource that supports policies — they govern cross-account
 * backup sharing). Provide the implementation with
 * `Effect.provide(AWS.CloudHSMV2.GetResourcePolicyHttp)`.
 * @binding
 * @section Sharing Backups
 * @example Read A Backup's Sharing Policy
 * ```typescript
 * const getResourcePolicy = yield* AWS.CloudHSMV2.GetResourcePolicy();
 *
 * const { Policy } = yield* getResourcePolicy({ ResourceArn: backupArn });
 * ```
 */
export interface GetResourcePolicy extends Binding.Service<
  GetResourcePolicy,
  "AWS.CloudHSMV2.GetResourcePolicy",
  () => Effect.Effect<
    (
      request?: cloudhsm.GetResourcePolicyRequest,
    ) => Effect.Effect<
      cloudhsm.GetResourcePolicyResponse,
      cloudhsm.GetResourcePolicyError
    >
  >
> {}
export const GetResourcePolicy = Binding.Service<GetResourcePolicy>(
  "AWS.CloudHSMV2.GetResourcePolicy",
);
