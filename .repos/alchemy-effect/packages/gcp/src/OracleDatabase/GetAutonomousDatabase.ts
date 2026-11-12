import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AutonomousDatabase } from "./AutonomousDatabase.ts";

export interface GetAutonomousDatabaseRequest extends Omit<
  oracle.GetProjectsLocationsAutonomousDatabasesRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `autonomousDatabases.get`.
 *
 * ### Observing Autonomous Databases
 * **Example:** Read the bound database
 * ```typescript
 * const get = yield* GCP.OracleDatabase.GetAutonomousDatabase(db);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetAutonomousDatabase extends Binding.Service<
  GetAutonomousDatabase,
  "GCP.OracleDatabase.GetAutonomousDatabase",
  (
    database: AutonomousDatabase,
  ) => Effect.Effect<
    (
      request?: GetAutonomousDatabaseRequest,
    ) => Effect.Effect<
      oracle.AutonomousDatabase,
      oracle.GetProjectsLocationsAutonomousDatabasesError,
      RuntimeContext
    >
  >
> {}

export const GetAutonomousDatabase = Binding.Service<GetAutonomousDatabase>(
  "GCP.OracleDatabase.GetAutonomousDatabase",
);
