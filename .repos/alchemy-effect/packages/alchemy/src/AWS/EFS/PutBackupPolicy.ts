import type * as efs from "@distilled.cloud/aws/efs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * `PutBackupPolicy` request with `FileSystemId` injected from the bound
 * {@link FileSystem}.
 */
export interface PutBackupPolicyRequest extends Omit<
  efs.PutBackupPolicyRequest,
  "FileSystemId"
> {}

/**
 * Runtime binding for the `PutBackupPolicy` operation (IAM action
 * `elasticfilesystem:PutBackupPolicy` on the file system ARN).
 *
 * Starts or stops AWS Backup automatic backups for the bound
 * {@link FileSystem} at runtime. For declarative control, prefer the
 * FileSystem resource's `backup` prop — this binding is for operational
 * tooling that toggles backups on demand. Provide the implementation with
 * `Effect.provide(AWS.EFS.PutBackupPolicyHttp)`.
 * @binding
 * @section Backup Policy
 * @example Enable automatic backups
 * ```typescript
 * const putBackupPolicy = yield* AWS.EFS.PutBackupPolicy(files);
 *
 * const { BackupPolicy } = yield* putBackupPolicy({
 *   BackupPolicy: { Status: "ENABLED" },
 * });
 * ```
 */
export interface PutBackupPolicy extends Binding.Service<
  PutBackupPolicy,
  "AWS.EFS.PutBackupPolicy",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    (
      request: PutBackupPolicyRequest,
    ) => Effect.Effect<efs.BackupPolicyDescription, efs.PutBackupPolicyError>
  >
> {}
export const PutBackupPolicy = Binding.Service<PutBackupPolicy>(
  "AWS.EFS.PutBackupPolicy",
);
