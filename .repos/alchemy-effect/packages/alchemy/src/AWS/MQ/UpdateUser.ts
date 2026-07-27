import type * as mq from "@distilled.cloud/aws/mq";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Broker } from "./Broker.ts";

/**
 * Runtime binding for the `UpdateUser` operation (IAM action
 * `mq:UpdateUser`), scoped to one {@link Broker}.
 *
 * Updates a broker user's password, console access, or groups — e.g.
 * rotating credentials at runtime. On ActiveMQ the change is staged and
 * applied at the next broker reboot or maintenance window; on RabbitMQ it
 * takes effect immediately. Provide the implementation with
 * `Effect.provide(AWS.MQ.UpdateUserHttp)`.
 * @binding
 * @section Managing Users
 * @example Rotate a User's Password
 * ```typescript
 * const updateUser = yield* MQ.UpdateUser(broker);
 *
 * yield* updateUser({
 *   Username: "tenant-42",
 *   Password: Redacted.make("NewSecretPassw0rd"),
 * });
 * ```
 */
export interface UpdateUser extends Binding.Service<
  UpdateUser,
  "AWS.MQ.UpdateUser",
  (
    broker: Broker,
  ) => Effect.Effect<
    (
      request: Omit<mq.UpdateUserRequest, "BrokerId">,
    ) => Effect.Effect<mq.UpdateUserResponse, mq.UpdateUserError>
  >
> {}
export const UpdateUser = Binding.Service<UpdateUser>("AWS.MQ.UpdateUser");
