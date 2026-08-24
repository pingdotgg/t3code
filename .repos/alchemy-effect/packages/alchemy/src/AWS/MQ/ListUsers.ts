import type * as mq from "@distilled.cloud/aws/mq";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Broker } from "./Broker.ts";

/**
 * Runtime binding for the `ListUsers` operation (IAM action
 * `mq:ListUsers`), scoped to one {@link Broker}.
 *
 * Lists all users on the broker, including any with staged pending changes.
 * Provide the implementation with `Effect.provide(AWS.MQ.ListUsersHttp)`.
 * @binding
 * @section Managing Users
 * @example List Broker Users
 * ```typescript
 * const listUsers = yield* MQ.ListUsers(broker);
 *
 * const page = yield* listUsers();
 * // page.Users → [{ Username: "admin" }, { Username: "tenant-42", PendingChange: "CREATE" }]
 * ```
 */
export interface ListUsers extends Binding.Service<
  ListUsers,
  "AWS.MQ.ListUsers",
  (
    broker: Broker,
  ) => Effect.Effect<
    (
      request?: Omit<mq.ListUsersRequest, "BrokerId">,
    ) => Effect.Effect<mq.ListUsersResponse, mq.ListUsersError>
  >
> {}
export const ListUsers = Binding.Service<ListUsers>("AWS.MQ.ListUsers");
