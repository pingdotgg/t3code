import type * as mq from "@distilled.cloud/aws/mq";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Broker } from "./Broker.ts";

/**
 * Runtime binding for the `DescribeUser` operation (IAM action
 * `mq:DescribeUser`), scoped to one {@link Broker}.
 *
 * Reads a broker user's attributes — console access, groups, and any
 * pending change staged for the next reboot. Provide the implementation
 * with `Effect.provide(AWS.MQ.DescribeUserHttp)`.
 * @binding
 * @section Managing Users
 * @example Inspect a User
 * ```typescript
 * const describeUser = yield* MQ.DescribeUser(broker);
 *
 * const user = yield* describeUser({ Username: "tenant-42" });
 * // user.Groups, user.Pending?.PendingChange → "CREATE" | "UPDATE" | "DELETE"
 * ```
 */
export interface DescribeUser extends Binding.Service<
  DescribeUser,
  "AWS.MQ.DescribeUser",
  (
    broker: Broker,
  ) => Effect.Effect<
    (
      request: Omit<mq.DescribeUserRequest, "BrokerId">,
    ) => Effect.Effect<mq.DescribeUserResponse, mq.DescribeUserError>
  >
> {}
export const DescribeUser = Binding.Service<DescribeUser>(
  "AWS.MQ.DescribeUser",
);
