import type * as mq from "@distilled.cloud/aws/mq";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Broker } from "./Broker.ts";

/**
 * Runtime binding for the `CreateUser` operation (IAM action
 * `mq:CreateUser`), scoped to one {@link Broker}.
 *
 * Creates a broker user — e.g. provisioning per-tenant credentials at
 * runtime. On ActiveMQ the change is staged and applied at the next broker
 * reboot or maintenance window; on RabbitMQ it takes effect immediately.
 * The password is marked sensitive — pass a `Redacted` value and it stays
 * redacted until wire encoding. Provide the implementation with
 * `Effect.provide(AWS.MQ.CreateUserHttp)`.
 * @binding
 * @section Managing Users
 * @example Provision a User at Runtime
 * ```typescript
 * const createUser = yield* MQ.CreateUser(broker);
 *
 * yield* createUser({
 *   Username: "tenant-42",
 *   Password: Redacted.make("SuperSecretPassw0rd"),
 * });
 * ```
 */
export interface CreateUser extends Binding.Service<
  CreateUser,
  "AWS.MQ.CreateUser",
  (
    broker: Broker,
  ) => Effect.Effect<
    (
      request: Omit<mq.CreateUserRequest, "BrokerId">,
    ) => Effect.Effect<mq.CreateUserResponse, mq.CreateUserError>
  >
> {}
export const CreateUser = Binding.Service<CreateUser>("AWS.MQ.CreateUser");
