import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDBInstances` operation (IAM action
 * `rds:DescribeDBInstances`).
 *
 * Lists the account's Neptune instances (or one instance by identifier) —
 * status, endpoint, instance class, cluster membership — for health checks
 * and reader discovery. Provide the implementation with
 * `Effect.provide(AWS.Neptune.DescribeDBInstancesHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example Check an Instance's Status
 * ```typescript
 * const describeDBInstances = yield* AWS.Neptune.DescribeDBInstances();
 *
 * const page = yield* describeDBInstances({
 *   DBInstanceIdentifier: instanceId,
 * });
 * const status = page.DBInstances?.[0]?.DBInstanceStatus;
 * ```
 */
export interface DescribeDBInstances extends Binding.Service<
  DescribeDBInstances,
  "AWS.Neptune.DescribeDBInstances",
  () => Effect.Effect<
    (
      request?: neptune.DescribeDBInstancesMessage,
    ) => Effect.Effect<
      neptune.DBInstanceMessage,
      neptune.DescribeDBInstancesError
    >
  >
> {}
export const DescribeDBInstances = Binding.Service<DescribeDBInstances>(
  "AWS.Neptune.DescribeDBInstances",
);
