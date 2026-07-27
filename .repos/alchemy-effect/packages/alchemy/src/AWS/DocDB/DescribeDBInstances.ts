import type * as docdb from "@distilled.cloud/aws/docdb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDBInstances` operation (IAM action
 * `rds:DescribeDBInstances` — DocumentDB shares the RDS control plane).
 *
 * Lists the account's DocumentDB instances (optionally filtered by
 * identifier or cluster) with status, endpoint, and class embedded — the
 * building block of instance-health monitoring and reboot automation.
 * Provide the implementation with
 * `Effect.provide(AWS.DocDB.DescribeDBInstancesHttp)`.
 * @binding
 * @section Monitoring Instances
 * @example Check the Cluster's Instance Health
 * ```typescript
 * const describeDBInstances = yield* DocDB.DescribeDBInstances();
 *
 * const page = yield* describeDBInstances({
 *   Filters: [{ Name: "db-cluster-id", Values: [clusterId] }],
 * });
 * const available = page.DBInstances?.filter(
 *   (instance) => instance.DBInstanceStatus === "available",
 * );
 * ```
 */
export interface DescribeDBInstances extends Binding.Service<
  DescribeDBInstances,
  "AWS.DocDB.DescribeDBInstances",
  () => Effect.Effect<
    (
      request?: docdb.DescribeDBInstancesMessage,
    ) => Effect.Effect<docdb.DBInstanceMessage, docdb.DescribeDBInstancesError>
  >
> {}
export const DescribeDBInstances = Binding.Service<DescribeDBInstances>(
  "AWS.DocDB.DescribeDBInstances",
);
