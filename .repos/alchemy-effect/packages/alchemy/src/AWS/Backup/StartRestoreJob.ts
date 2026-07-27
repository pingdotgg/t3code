import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartRestoreJob` request with `IamRoleArn` defaulting to the bound
 * restore role.
 */
export interface StartRestoreJobRequest extends Omit<
  backup.StartRestoreJobInput,
  "IamRoleArn"
> {
  /**
   * IAM role AWS Backup assumes to create the restored resource.
   * @default the restore role bound via `StartRestoreJob(role)`
   */
  IamRoleArn?: string;
}

/**
 * Runtime binding for the `StartRestoreJob` operation (IAM actions
 * `backup:StartRestoreJob` + `iam:PassRole` on the restore role) — restore a
 * recovery point from a deployed Function.
 *
 * The binding is constructed with the **restore role** (the IAM role AWS
 * Backup assumes to recreate the resource; its trust policy must allow
 * `backup.amazonaws.com`), injected as `IamRoleArn` unless the request
 * overrides it. `backup:StartRestoreJob` authorizes on the recovery point's
 * underlying resource ARN, so the grant is on `*`. Provide the
 * implementation with `Effect.provide(AWS.Backup.StartRestoreJobHttp)`.
 * @binding
 * @section Restoring Recovery Points
 * @example Restore The Latest Recovery Point
 * ```typescript
 * const startRestoreJob = yield* AWS.Backup.StartRestoreJob(restoreRole);
 *
 * const job = yield* startRestoreJob({
 *   RecoveryPointArn: recoveryPointArn,
 *   Metadata: restoreMetadata,
 * });
 * yield* Effect.log(`restore job ${job.RestoreJobId} started`);
 * ```
 */
export interface StartRestoreJob extends Binding.Service<
  StartRestoreJob,
  "AWS.Backup.StartRestoreJob",
  <R extends Role>(
    restoreRole: R,
  ) => Effect.Effect<
    (
      request: StartRestoreJobRequest,
    ) => Effect.Effect<
      backup.StartRestoreJobOutput,
      backup.StartRestoreJobError
    >
  >
> {}
export const StartRestoreJob = Binding.Service<StartRestoreJob>(
  "AWS.Backup.StartRestoreJob",
);
