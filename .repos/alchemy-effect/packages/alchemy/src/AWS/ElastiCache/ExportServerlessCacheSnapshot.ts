import type * as elasticache from "@distilled.cloud/aws/elasticache";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ExportServerlessCacheSnapshot` operation (IAM
 * action `elasticache:ExportServerlessCacheSnapshot`).
 *
 * Exports a serverless cache snapshot's data to an S3 bucket — e.g. shipping
 * a backup out of ElastiCache for offline analysis or cross-account
 * restore. Available for valkey and redis only. The target bucket must grant
 * the ElastiCache service access via its bucket policy. Provide the
 * implementation with
 * `Effect.provide(AWS.ElastiCache.ExportServerlessCacheSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Export a Snapshot to S3
 * ```typescript
 * const exportSnapshot = yield* ElastiCache.ExportServerlessCacheSnapshot();
 *
 * yield* exportSnapshot({
 *   ServerlessCacheSnapshotName: "nightly",
 *   S3BucketName: "my-backup-bucket",
 * });
 * ```
 */
export interface ExportServerlessCacheSnapshot extends Binding.Service<
  ExportServerlessCacheSnapshot,
  "AWS.ElastiCache.ExportServerlessCacheSnapshot",
  () => Effect.Effect<
    (
      request: elasticache.ExportServerlessCacheSnapshotRequest,
    ) => Effect.Effect<
      elasticache.ExportServerlessCacheSnapshotResponse,
      elasticache.ExportServerlessCacheSnapshotError
    >
  >
> {}
export const ExportServerlessCacheSnapshot =
  Binding.Service<ExportServerlessCacheSnapshot>(
    "AWS.ElastiCache.ExportServerlessCacheSnapshot",
  );
