import { Resource } from "../../Resource.ts";
import {
  type BaseBranchAttributes,
  type BaseBranchProps,
  makeBranchProvider,
} from "../Branch.ts";
import type { Providers } from "../Providers.ts";
import type { PostgresClusterSize } from "./PostgresClusterSize.ts";
import type { PostgresDatabase } from "./PostgresDatabase.ts";
import {
  runPostgresImports,
  runPostgresMigrations,
} from "./PostgresMigrations.ts";

/**
 * Properties for creating or updating a {@link PostgresBranch}.
 */
export interface PostgresBranchProps extends BaseBranchProps {
  /**
   * The Postgres database. Either a string database name or a
   * {@link PostgresDatabase} resource.
   */
  database: string | PostgresDatabase;

  /**
   * PostgreSQL cluster size for the branch. Required if `backupId` is provided.
   * Short sizes are expanded using the target branch region.
   */
  clusterSize?: PostgresClusterSize;

  /**
   * Parent branch — either a string name or another {@link PostgresBranch}.
   * @default "main"
   */
  parentBranch?: string | PostgresBranch;
}

/**
 * Output attributes of a deployed {@link PostgresBranch}.
 */
export interface PostgresBranchAttributes extends BaseBranchAttributes {}

/**
 * A PlanetScale branch of a {@link PostgresDatabase}. For MySQL branches
 * use {@link MySQLBranch} instead.
 *
 * @section Creating a Branch
 * @example Branch from main
 * ```typescript
 * const branch = yield* Planetscale.PostgresBranch("Feature123", {
 *   database: "my-db",
 *   parentBranch: "main",
 * });
 * ```
 *
 * @example Branch from a PostgresDatabase resource
 * ```typescript
 * const db = yield* Planetscale.PostgresDatabase("MyDb", { clusterSize: "PS_10" });
 * const branch = yield* Planetscale.PostgresBranch("Feature456", {
 *   database: db,
 *   parentBranch: "main",
 * });
 * ```
 *
 * @section Migrations and seed data
 * @example Apply migrations on a branch
 * ```typescript
 * const branch = yield* Planetscale.PostgresBranch("Feature123", {
 *   database: db,
 *   parentBranch: "main",
 *   migrationsDir: "./migrations",
 *   importFiles: ["./seed.sql"],
 * });
 * ```
 */
export type PostgresBranch = Resource<
  "Planetscale.PostgresBranch",
  PostgresBranchProps,
  PostgresBranchAttributes,
  never,
  Providers
>;

export const PostgresBranch = Resource<PostgresBranch>(
  "Planetscale.PostgresBranch",
);

export const PostgresBranchProvider = () =>
  makeBranchProvider({
    resource: PostgresBranch,
    expectedKind: "postgresql",
    engineLabel: "PostgresBranch",
    runners: {
      runMigrations: runPostgresMigrations,
      runImports: runPostgresImports,
    },
  });
