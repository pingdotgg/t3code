import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dms:DescribeReplications`.
 *
 * Bind this operation (account-level) to look up DMS Serverless
 * replications and their provisioning/replication status — filter by
 * `replication-config-arn` or `replication-config-id`. Pair with
 * {@link StartReplication} / {@link StopReplication} for serverless
 * replication automation. Provide the implementation with
 * `Effect.provide(AWS.DMS.DescribeReplicationsHttp)`.
 * @binding
 * @section Orchestrating Serverless Replications
 * @example Check a Serverless Replication's Status
 * ```typescript
 * // init — account-level, no target resource
 * const describeReplications = yield* AWS.DMS.DescribeReplications();
 *
 * // runtime
 * const { Replications } = yield* describeReplications({
 *   Filters: [{ Name: "replication-config-arn", Values: [configArn] }],
 * });
 * // Replications[0].Status: "created" | "running" | "stopped" | …
 * ```
 */
export interface DescribeReplications extends Binding.Service<
  DescribeReplications,
  "AWS.DMS.DescribeReplications",
  () => Effect.Effect<
    (
      request?: dms.DescribeReplicationsMessage,
    ) => Effect.Effect<
      dms.DescribeReplicationsResponse,
      dms.DescribeReplicationsError
    >
  >
> {}

export const DescribeReplications = Binding.Service<DescribeReplications>(
  "AWS.DMS.DescribeReplications",
);
