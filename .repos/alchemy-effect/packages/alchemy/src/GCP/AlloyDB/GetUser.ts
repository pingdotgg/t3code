import type * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ClustersUser } from "./ClustersUser.ts";

export interface GetUserRequest extends Omit<
  alloydb.GetProjectsLocationsClustersUsersRequest,
  "name"
> {}

/**
 * Runtime binding for AlloyDB `users.get`.
 *
 * Bind this operation to a {@link ClustersUser} in a Function/Action
 * init phase. Provide {@link GetUserHttp}.
 *
 * ### Observing Users
 * **Example:** Read the bound user
 * ```typescript
 * const getUser = yield* GCP.AlloyDB.GetUser(appUser);
 * const live = yield* getUser();
 * ```
 *
 * @binding
 * @category AlloyDB
 */
export interface GetUser extends Binding.Service<
  GetUser,
  "GCP.AlloyDB.GetUser",
  (
    user: ClustersUser,
  ) => Effect.Effect<
    (
      request?: GetUserRequest,
    ) => Effect.Effect<
      alloydb.User,
      alloydb.GetProjectsLocationsClustersUsersError,
      RuntimeContext
    >
  >
> {}

export const GetUser = Binding.Service<GetUser>("GCP.AlloyDB.GetUser");
