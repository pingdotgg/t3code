import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeBackups` operation (IAM action
 * `fsx:DescribeBackups` on `*`).
 *
 * Lists FSx backups — optionally filtered by `file-system-id`,
 * `backup-type`, or explicit `BackupIds` — from inside a function runtime.
 * Pairs with {@link CreateBackup} to poll a runtime-initiated backup until
 * it reaches `AVAILABLE`. Provide the implementation with
 * `Effect.provide(AWS.FSx.DescribeBackupsHttp)`.
 * @binding
 * @section Managing Backups at Runtime
 * @example List a file system's backups
 * ```typescript
 * const describeBackups = yield* AWS.FSx.DescribeBackups();
 *
 * const response = yield* describeBackups({
 *   Filters: [{ Name: "file-system-id", Values: [fileSystemId] }],
 * });
 * yield* Effect.log(`${response.Backups?.length ?? 0} backups`);
 * ```
 */
export interface DescribeBackups extends Binding.Service<
  DescribeBackups,
  "AWS.FSx.DescribeBackups",
  () => Effect.Effect<
    (
      request?: fsx.DescribeBackupsRequest,
    ) => Effect.Effect<fsx.DescribeBackupsResponse, fsx.DescribeBackupsError>
  >
> {}
export const DescribeBackups = Binding.Service<DescribeBackups>(
  "AWS.FSx.DescribeBackups",
);
