import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BackupVault } from "./BackupVault.ts";

/**
 * `DescribeRecoveryPoint` request with `BackupVaultName` injected from the
 * bound {@link BackupVault}.
 */
export interface DescribeRecoveryPointRequest extends Omit<
  backup.DescribeRecoveryPointInput,
  "BackupVaultName"
> {}

/**
 * Runtime binding for the `DescribeRecoveryPoint` operation (IAM action
 * `backup:DescribeRecoveryPoint`).
 *
 * Returns metadata for a recovery point stored in the bound
 * {@link BackupVault} — status, lifecycle, size, and restorability. Provide
 * the implementation with
 * `Effect.provide(AWS.Backup.DescribeRecoveryPointHttp)`.
 * @binding
 * @section Recovery Points
 * @example Inspect A Recovery Point
 * ```typescript
 * const describeRecoveryPoint = yield* AWS.Backup.DescribeRecoveryPoint(vault);
 *
 * const point = yield* describeRecoveryPoint({
 *   RecoveryPointArn: recoveryPointArn,
 * });
 * yield* Effect.log(`status: ${point.Status}`);
 * ```
 */
export interface DescribeRecoveryPoint extends Binding.Service<
  DescribeRecoveryPoint,
  "AWS.Backup.DescribeRecoveryPoint",
  (
    vault: BackupVault,
  ) => Effect.Effect<
    (
      request: DescribeRecoveryPointRequest,
    ) => Effect.Effect<
      backup.DescribeRecoveryPointOutput,
      backup.DescribeRecoveryPointError
    >
  >
> {}
export const DescribeRecoveryPoint = Binding.Service<DescribeRecoveryPoint>(
  "AWS.Backup.DescribeRecoveryPoint",
);
