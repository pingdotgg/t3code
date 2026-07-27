import type * as mq from "@distilled.cloud/aws/mq";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Broker } from "./Broker.ts";

/**
 * Runtime binding for the `DeleteUser` operation (IAM action
 * `mq:DeleteUser`), scoped to one {@link Broker}.
 *
 * Deletes a broker user — e.g. revoking per-tenant credentials at runtime.
 * On ActiveMQ the change is staged and applied at the next broker reboot or
 * maintenance window; on RabbitMQ it takes effect immediately. Provide the
 * implementation with `Effect.provide(AWS.MQ.DeleteUserHttp)`.
 * @binding
 * @section Managing Users
 * @example Revoke a User
 * ```typescript
 * const deleteUser = yield* MQ.DeleteUser(broker);
 *
 * yield* deleteUser({ Username: "tenant-42" });
 * ```
 */
export interface DeleteUser extends Binding.Service<
  DeleteUser,
  "AWS.MQ.DeleteUser",
  (
    broker: Broker,
  ) => Effect.Effect<
    (
      request: Omit<mq.DeleteUserRequest, "BrokerId">,
    ) => Effect.Effect<mq.DeleteUserResponse, mq.DeleteUserError>
  >
> {}
export const DeleteUser = Binding.Service<DeleteUser>("AWS.MQ.DeleteUser");
