import type * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteResourcePolicy` operation (IAM action
 * `cloudhsm:DeleteResourcePolicy`).
 *
 * Removes the resource policy from a CloudHSM backup, unsharing it (and
 * removing it from any RAM resource shares); clusters already created from
 * the backup are unaffected. Provide the implementation with
 * `Effect.provide(AWS.CloudHSMV2.DeleteResourcePolicyHttp)`.
 * @binding
 * @section Sharing Backups
 * @example Unshare A Backup
 * ```typescript
 * const deleteResourcePolicy = yield* AWS.CloudHSMV2.DeleteResourcePolicy();
 *
 * yield* deleteResourcePolicy({ ResourceArn: backupArn });
 * ```
 */
export interface DeleteResourcePolicy extends Binding.Service<
  DeleteResourcePolicy,
  "AWS.CloudHSMV2.DeleteResourcePolicy",
  () => Effect.Effect<
    (
      request: cloudhsm.DeleteResourcePolicyRequest,
    ) => Effect.Effect<
      cloudhsm.DeleteResourcePolicyResponse,
      cloudhsm.DeleteResourcePolicyError
    >
  >
> {}
export const DeleteResourcePolicy = Binding.Service<DeleteResourcePolicy>(
  "AWS.CloudHSMV2.DeleteResourcePolicy",
);
