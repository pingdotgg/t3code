import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AutonomousDatabase } from "./AutonomousDatabase.ts";

export interface RestartAutonomousDatabaseRequest extends Omit<
  oracle.RestartProjectsLocationsAutonomousDatabasesRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `autonomousDatabases.restart`.
 *
 * Grants `roles/oracledatabase.autonomousDatabaseAdmin` on the project
 * because `autonomousDatabases.restart` is only in the admin roles and
 * Oracle Database@Google Cloud has no per-resource IAM.
 *
 * ### Restarting a database
 * **Example:** Restart the bound database
 * ```typescript
 * const restart = yield* GCP.OracleDatabase.RestartAutonomousDatabase(db);
 * yield* restart();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface RestartAutonomousDatabase extends Binding.Service<
  RestartAutonomousDatabase,
  "GCP.OracleDatabase.RestartAutonomousDatabase",
  (
    database: AutonomousDatabase,
  ) => Effect.Effect<
    (
      request?: RestartAutonomousDatabaseRequest,
    ) => Effect.Effect<
      oracle.Operation,
      oracle.RestartProjectsLocationsAutonomousDatabasesError,
      RuntimeContext
    >
  >
> {}

export const RestartAutonomousDatabase =
  Binding.Service<RestartAutonomousDatabase>(
    "GCP.OracleDatabase.RestartAutonomousDatabase",
  );
