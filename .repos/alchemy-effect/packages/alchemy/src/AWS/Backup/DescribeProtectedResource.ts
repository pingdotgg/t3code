import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeProtectedResource` operation (IAM action
 * `backup:DescribeProtectedResource`).
 *
 * Returns backup metadata for a protected resource by its ARN — last backup
 * time, resource type, and latest recovery point. Provide the implementation
 * with `Effect.provide(AWS.Backup.DescribeProtectedResourceHttp)`.
 * @binding
 * @section Protected Resources
 * @example Look Up A Resource's Backup Status
 * ```typescript
 * const describeProtectedResource =
 *   yield* AWS.Backup.DescribeProtectedResource();
 *
 * const info = yield* describeProtectedResource({
 *   ResourceArn: tableArn,
 * });
 * yield* Effect.log(`last backup: ${info.LastBackupTime}`);
 * ```
 */
export interface DescribeProtectedResource extends Binding.Service<
  DescribeProtectedResource,
  "AWS.Backup.DescribeProtectedResource",
  () => Effect.Effect<
    (
      request: backup.DescribeProtectedResourceInput,
    ) => Effect.Effect<
      backup.DescribeProtectedResourceOutput,
      backup.DescribeProtectedResourceError
    >
  >
> {}
export const DescribeProtectedResource =
  Binding.Service<DescribeProtectedResource>(
    "AWS.Backup.DescribeProtectedResource",
  );
