import { Resource } from "../../Resource.ts";
import {
  type BaseBranchAttributes,
  type BaseBranchProps,
  makeBranchProvider,
} from "../Branch.ts";
import type { Providers } from "../Providers.ts";
import type { MySQLClusterSize } from "./MySQLClusterSize.ts";
import { runMySQLImports, runMySQLMigrations } from "./MySQLMigrations.ts";
import type { MySQLDatabase } from "./MySQLDatabase.ts";

/**
 * Properties for creating or updating a {@link MySQLBranch}.
 */
export interface MySQLBranchProps extends BaseBranchProps {
  /**
   * Whether the branch should be a production branch.
   */
  isProduction: boolean;

  /**
   * The MySQL database. Either a string database name or a
   * {@link MySQLDatabase} resource.
   */
  database: string | MySQLDatabase;

  /**
   * MySQL cluster size for the branch. Required if `backupId` is provided.
   * For non-production branches must be `"PS_DEV"`.
   */
  clusterSize?: MySQLClusterSize;

  /**
   * Parent branch — either a string name or another {@link MySQLBranch}.
   * @default "main"
   */
  parentBranch?: string | MySQLBranch;
}

/**
 * Output attributes of a deployed {@link MySQLBranch}.
 */
export interface MySQLBranchAttributes extends BaseBranchAttributes {}

/**
 * A PlanetScale branch of a {@link MySQLDatabase}. For PostgreSQL branches
 * use {@link PostgresBranch} instead.
 *
 * @section Creating a Branch
 * @example Branch from main
 * ```typescript
 * const branch = yield* Planetscale.MySQLBranch("Feature123", {
 *   database: "my-db",
 *   parentBranch: "main",
 *   isProduction: false,
 * });
 * ```
 *
 * @example Branch from a MySQLDatabase resource
 * ```typescript
 * const db = yield* Planetscale.MySQLDatabase("MyDb", { clusterSize: "PS_10" });
 * const branch = yield* Planetscale.MySQLBranch("Feature456", {
 *   database: db,
 *   parentBranch: "main",
 *   isProduction: false,
 * });
 * ```
 *
 * @section Restoring from Backup
 * @example Branch restored from a backup
 * ```typescript
 * const branch = yield* Planetscale.MySQLBranch("Restored", {
 *   database: "my-db",
 *   parentBranch: "main",
 *   isProduction: true,
 *   backupId: "backup-123",
 *   clusterSize: "PS_10",
 * });
 * ```
 *
 * @section Migrations and seed data
 * @example Apply migrations on a branch
 * ```typescript
 * const branch = yield* Planetscale.MySQLBranch("Feature123", {
 *   database: db,
 *   parentBranch: "main",
 *   isProduction: false,
 *   migrationsDir: "./migrations",
 *   importFiles: ["./seed.sql"],
 * });
 * ```
 */
export type MySQLBranch = Resource<
  "Planetscale.MySQLBranch",
  MySQLBranchProps,
  MySQLBranchAttributes,
  never,
  Providers
>;

export const MySQLBranch = Resource<MySQLBranch>("Planetscale.MySQLBranch");

export const MySQLBranchProvider = () =>
  makeBranchProvider({
    resource: MySQLBranch,
    expectedKind: "mysql",
    engineLabel: "MySQLBranch",
    runners: {
      runMigrations: runMySQLMigrations,
      runImports: runMySQLImports,
    },
  });
