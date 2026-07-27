import type * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `PutResourcePolicy` operation (IAM action
 * `cloudhsm:PutResourcePolicy`).
 *
 * Creates or replaces the resource policy on a CloudHSM backup, sharing a
 * `READY` backup you own with other accounts (AWS recommends RAM for
 * discoverable multi-resource shares; this is the direct API). Provide the
 * implementation with `Effect.provide(AWS.CloudHSMV2.PutResourcePolicyHttp)`.
 * @binding
 * @section Sharing Backups
 * @example Share A Backup With Another Account
 * ```typescript
 * const putResourcePolicy = yield* AWS.CloudHSMV2.PutResourcePolicy();
 *
 * yield* putResourcePolicy({
 *   ResourceArn: backupArn,
 *   Policy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { AWS: "arn:aws:iam::123456789012:root" },
 *       Action: ["cloudhsm:DescribeBackups"],
 *       Resource: backupArn,
 *     }],
 *   }),
 * });
 * ```
 */
export interface PutResourcePolicy extends Binding.Service<
  PutResourcePolicy,
  "AWS.CloudHSMV2.PutResourcePolicy",
  () => Effect.Effect<
    (
      request: cloudhsm.PutResourcePolicyRequest,
    ) => Effect.Effect<
      cloudhsm.PutResourcePolicyResponse,
      cloudhsm.PutResourcePolicyError
    >
  >
> {}
export const PutResourcePolicy = Binding.Service<PutResourcePolicy>(
  "AWS.CloudHSMV2.PutResourcePolicy",
);
