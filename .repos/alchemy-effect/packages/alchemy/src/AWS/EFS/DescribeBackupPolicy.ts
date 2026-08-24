import type * as efs from "@distilled.cloud/aws/efs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Runtime binding for the `DescribeBackupPolicy` operation (IAM action
 * `elasticfilesystem:DescribeBackupPolicy` on the file system ARN).
 *
 * Reads whether AWS Backup automatic backups are enabled for the bound
 * {@link FileSystem}. A file system that has never had a backup policy
 * fails with the typed `PolicyNotFound`. Provide the implementation with
 * `Effect.provide(AWS.EFS.DescribeBackupPolicyHttp)`.
 * @binding
 * @section Backup Policy
 * @example Read the backup policy status
 * ```typescript
 * const describeBackupPolicy = yield* AWS.EFS.DescribeBackupPolicy(files);
 *
 * const status = yield* describeBackupPolicy().pipe(
 *   Effect.map((r) => r.BackupPolicy?.Status ?? "DISABLED"),
 *   Effect.catchTag("PolicyNotFound", () => Effect.succeed("DISABLED")),
 * );
 * ```
 */
export interface DescribeBackupPolicy extends Binding.Service<
  DescribeBackupPolicy,
  "AWS.EFS.DescribeBackupPolicy",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    () => Effect.Effect<
      efs.BackupPolicyDescription,
      efs.DescribeBackupPolicyError
    >
  >
> {}
export const DescribeBackupPolicy = Binding.Service<DescribeBackupPolicy>(
  "AWS.EFS.DescribeBackupPolicy",
);
