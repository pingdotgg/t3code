import type * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeBackups` operation (IAM action
 * `cloudhsm:DescribeBackups`).
 *
 * Lists the account's CloudHSM cluster backups (or backups shared with the
 * account when `Shared` is true), optionally filtered by backup id, cluster
 * id or state — the observation half of backup-retention and disaster-
 * recovery automation. Provide the implementation with
 * `Effect.provide(AWS.CloudHSMV2.DescribeBackupsHttp)`.
 * @binding
 * @section Managing Backups
 * @example List A Cluster's Ready Backups
 * ```typescript
 * const describeBackups = yield* AWS.CloudHSMV2.DescribeBackups();
 *
 * const page = yield* describeBackups({
 *   Filters: { clusterIds: [clusterId], states: ["READY"] },
 * });
 * ```
 */
export interface DescribeBackups extends Binding.Service<
  DescribeBackups,
  "AWS.CloudHSMV2.DescribeBackups",
  () => Effect.Effect<
    (
      request?: cloudhsm.DescribeBackupsRequest,
    ) => Effect.Effect<
      cloudhsm.DescribeBackupsResponse,
      cloudhsm.DescribeBackupsError
    >
  >
> {}
export const DescribeBackups = Binding.Service<DescribeBackups>(
  "AWS.CloudHSMV2.DescribeBackups",
);
