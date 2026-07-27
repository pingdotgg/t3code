import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxUsers` — lists the kdb users of the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxUsersHttp)`.
 * @binding
 * @section Managing kdb Users
 * @example List Users
 * ```typescript
 * const listUsers = yield* AWS.FinSpace.ListKxUsers(kdb);
 *
 * const { users } = yield* listUsers();
 * ```
 */
export interface ListKxUsers extends Binding.Service<
  ListKxUsers,
  "AWS.FinSpace.ListKxUsers",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListKxUsersRequest, "environmentId">,
    ) => Effect.Effect<SVC.ListKxUsersResponse, SVC.ListKxUsersError>
  >
> {}
export const ListKxUsers = Binding.Service<ListKxUsers>(
  "AWS.FinSpace.ListKxUsers",
);
