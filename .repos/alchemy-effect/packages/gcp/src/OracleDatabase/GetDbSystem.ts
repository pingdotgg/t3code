import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DbSystem } from "./DbSystem.ts";

export interface GetDbSystemRequest extends Omit<
  oracle.GetProjectsLocationsDbSystemsRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `dbSystems.get`.
 *
 * ### Observing DbSystems
 * **Example:** Read the bound system
 * ```typescript
 * const get = yield* GCP.OracleDatabase.GetDbSystem(system);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetDbSystem extends Binding.Service<
  GetDbSystem,
  "GCP.OracleDatabase.GetDbSystem",
  (
    system: DbSystem,
  ) => Effect.Effect<
    (
      request?: GetDbSystemRequest,
    ) => Effect.Effect<oracle.DbSystem, oracle.GetProjectsLocationsDbSystemsError, RuntimeContext>
  >
> {}

export const GetDbSystem = Binding.Service<GetDbSystem>("GCP.OracleDatabase.GetDbSystem");
