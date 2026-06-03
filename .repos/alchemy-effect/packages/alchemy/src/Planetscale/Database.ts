/**
 * Region selector for a PlanetScale Database.
 */
export interface DatabaseRegion {
  /**
   * Region slug (e.g. `"us-east"`, `"eu-west"`, `"gcp-us-central1"`).
   * @see https://planetscale.com/docs/concepts/regions#available-regions
   */
  slug: "us-east" | "eu-west" | "gcp-us-central1" | (string & {});
}

/**
 * Properties shared between {@link MySQLDatabase} and
 * {@link PostgresDatabase}. Engine-specific props live on the per-engine
 * resource types.
 */
export interface BaseDatabaseProps {
  /**
   * Database name. Must be lowercase. If omitted, a unique name will be
   * generated from the stack/stage/logical-id.
   */
  name?: string;

  /**
   * Region where the database will be created. Cannot be changed after
   * creation. If omitted, the organization's default region is used.
   */
  region?: DatabaseRegion;

  /**
   * Number of replicas for the database. `0` for non-HA, `2+` for HA.
   * Create-only.
   */
  replicas?: number;

  /**
   * Whether deploy requests must be approved by a database administrator
   * other than the request creator.
   */
  requireApprovalForDeploy?: boolean;

  /**
   * Whether to limit branch creation to the same region as the one
   * selected during database creation.
   */
  restrictBranchRegion?: boolean;

  /**
   * Whether the web console can be used on the production branch.
   */
  productionBranchWebConsole?: boolean;

  /**
   * The default branch of the database.
   * @default "main"
   */
  defaultBranch?: string;

  /**
   * Directory containing `.sql` migration files. Files are sorted by numeric
   * prefix (for example `0001_init.sql`) and applied in order against the
   * default branch.
   */
  migrationsDir?: string;

  /**
   * Name of the table used to track applied migrations.
   * @default "planetscale_migrations"
   */
  migrationsTable?: string;

  /**
   * Paths to additional `.sql` files to apply after migrations. Each file is
   * hashed; only files whose contents change are re-applied on later deploys.
   */
  importFiles?: string[];
}

/**
 * Output attributes shared by both database engines.
 */
export interface BaseDatabaseAttributes {
  /** The unique identifier of the database. */
  id: string;
  /** The name of the database. */
  name: string;
  /** The PlanetScale organization slug that owns the database. */
  organization: string;
  /** The current state of the database. */
  state: string;
  /** The default branch name. */
  defaultBranch: string;
  /** The plan tier (e.g. `"hobby"`, `"scaler"`). */
  plan: string;
  /** Time at which the database was created (ISO 8601). */
  createdAt: string;
  /** Time at which the database was last updated (ISO 8601). */
  updatedAt: string;
  /** HTML URL for accessing the database in the dashboard. */
  htmlUrl: string;
  /** The region of the database as reported by PlanetScale. */
  region: DatabaseRegion;
  /** The cluster size that was actually applied. */
  clusterSize: string;
  /** Directory containing migration files, if configured. */
  migrationsDir: string | undefined;
  /** Table used to track applied migrations, if configured. */
  migrationsTable: string | undefined;
  /** Content hashes for the last applied migration files. */
  migrationsHashes: Record<string, string>;
  /** Content hashes for the last applied import files. */
  importHashes: Record<string, string>;
  /**
   * Whether deploy requests must be approved by a database administrator
   * other than the request creator.
   */
  requireApprovalForDeploy: boolean;

  /**
   * Whether to limit branch creation to the same region as the one
   * selected during database creation.
   */
  restrictBranchRegion: boolean;

  /**
   * Whether the web console can be used on the production branch.
   */
  productionBranchWebConsole: boolean;
}
