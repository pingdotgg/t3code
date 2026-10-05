import type * as spanner from "@distilled.cloud/gcp/spanner_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Database } from "./Database.ts";

export interface GetDdlRequest extends Omit<
  spanner.GetDdlProjectsInstancesDatabasesRequest,
  "database"
> {}

/**
 * Runtime binding for Spanner `databases.getDdl`.
 *
 * Bind this operation to a {@link Database} in a Function/Action init
 * phase. Provide {@link GetDdlHttp}.
 *
 * ### Reading Schema
 * **Example:** Fetch live DDL
 * ```typescript
 * const getDdl = yield* GCP.Spanner.GetDdl(database);
 * const { statements } = yield* getDdl();
 * ```
 *
 * @binding
 * @category Spanner
 */
export interface GetDdl extends Binding.Service<
  GetDdl,
  "GCP.Spanner.GetDdl",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request?: GetDdlRequest,
    ) => Effect.Effect<
      spanner.GetDatabaseDdlResponse,
      spanner.GetDdlProjectsInstancesDatabasesError,
      RuntimeContext
    >
  >
> {}

export const GetDdl = Binding.Service<GetDdl>("GCP.Spanner.GetDdl");
