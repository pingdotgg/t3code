import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AutonomousDatabase } from "./AutonomousDatabase.ts";

export interface StopAutonomousDatabaseRequest extends Omit<
  oracle.StopProjectsLocationsAutonomousDatabasesRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `autonomousDatabases.stop`.
 *
 * Grants `roles/oracledatabase.autonomousDatabaseAdmin` on the project
 * because `autonomousDatabases.stop` is only in the admin roles and Oracle
 * Database@Google Cloud has no per-resource IAM.
 *
 * ### Stopping a database
 * **Example:** Stop the bound database
 * ```typescript
 * const stop = yield* GCP.OracleDatabase.StopAutonomousDatabase(db);
 * yield* stop();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface StopAutonomousDatabase extends Binding.Service<
  StopAutonomousDatabase,
  "GCP.OracleDatabase.StopAutonomousDatabase",
  (
    database: AutonomousDatabase,
  ) => Effect.Effect<
    (
      request?: StopAutonomousDatabaseRequest,
    ) => Effect.Effect<
      oracle.Operation,
      oracle.StopProjectsLocationsAutonomousDatabasesError,
      RuntimeContext
    >
  >
> {}

export const StopAutonomousDatabase = Binding.Service<StopAutonomousDatabase>(
  "GCP.OracleDatabase.StopAutonomousDatabase",
);
