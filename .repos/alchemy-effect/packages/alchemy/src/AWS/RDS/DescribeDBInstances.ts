import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDBInstances` operation (IAM action
 * `rds:DescribeDBInstances`).
 *
 * Lists the account's RDS instances (or one instance by identifier) —
 * status, endpoint, storage, engine version — for health checks and
 * instance discovery. Provide the implementation with
 * `Effect.provide(AWS.RDS.DescribeDBInstancesHttp)`.
 * @binding
 * @section Monitoring Databases
 * @example Check an Instance's Status
 * ```typescript
 * const describeDBInstances = yield* AWS.RDS.DescribeDBInstances();
 *
 * const page = yield* describeDBInstances({
 *   DBInstanceIdentifier: instanceId,
 * });
 * const status = page.DBInstances?.[0]?.DBInstanceStatus;
 * ```
 */
export interface DescribeDBInstances extends Binding.Service<
  DescribeDBInstances,
  "AWS.RDS.DescribeDBInstances",
  () => Effect.Effect<
    (
      request?: rds.DescribeDBInstancesMessage,
    ) => Effect.Effect<rds.DBInstanceMessage, rds.DescribeDBInstancesError>
  >
> {}
export const DescribeDBInstances = Binding.Service<DescribeDBInstances>(
  "AWS.RDS.DescribeDBInstances",
);
