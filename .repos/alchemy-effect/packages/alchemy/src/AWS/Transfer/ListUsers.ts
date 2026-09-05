import type * as transfer from "@distilled.cloud/aws/transfer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Server } from "./Server.ts";

/**
 * Runtime binding for `transfer:ListUsers`.
 *
 * Lists the users attached to the bound {@link Server} — the `ServerId` is
 * injected from the binding. Pass `MaxResults`/`NextToken` to page through
 * large user sets. The building block for self-service user portals over a
 * service-managed server. Provide the implementation with
 * `Effect.provide(AWS.Transfer.ListUsersHttp)`.
 * @binding
 * @section Managing Users at Runtime
 * @example List the Server's Users
 * ```typescript
 * // init — bind the operation to the server
 * const listUsers = yield* AWS.Transfer.ListUsers(server);
 *
 * // runtime
 * const { Users } = yield* listUsers();
 * yield* Effect.log(`users: ${Users.map((u) => u.UserName).join(", ")}`);
 * ```
 */
export interface ListUsers extends Binding.Service<
  ListUsers,
  "AWS.Transfer.ListUsers",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request?: Omit<transfer.ListUsersRequest, "ServerId">,
    ) => Effect.Effect<transfer.ListUsersResponse, transfer.ListUsersError>
  >
> {}
export const ListUsers = Binding.Service<ListUsers>("AWS.Transfer.ListUsers");
