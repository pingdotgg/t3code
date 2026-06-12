import { Credentials } from "@distilled.cloud/planetscale/Credentials";
import * as ops from "@distilled.cloud/planetscale/Operations";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { PlanetscaleConflict, waitForBranchReady } from "../Util.ts";
import type { PostgresBranch } from "./PostgresBranch.ts";
import type { PostgresDatabase } from "./PostgresDatabase.ts";
import type { InheritedRole } from "./PostgresRole.ts";

/**
 * Properties for creating or updating the default PlanetScale PostgreSQL
 * role for a branch.
 *
 * Default roles are only meant for PostgreSQL databases. For MySQL,
 * use {@link MySQLPassword} instead.
 */
export interface PostgresDefaultRoleProps {
  /**
   * PostgreSQL database — string name or {@link PostgresDatabase} resource.
   */
  database: string | PostgresDatabase;

  /**
   * Branch — string name or {@link PostgresBranch} resource.
   * @default "main"
   */
  branch?: string | PostgresBranch;

  /**
   * Whether to force-reset the default role if it already exists.
   * Adopting an existing default role is not supported because the
   * password is only returned at create time.
   * @default false
   */
  forceReset?: boolean;
}

/**
 * Output attributes of a deployed PlanetScale default role.
 */
export interface PostgresDefaultRoleAttributes {
  /** Unique identifier for the role (stable). */
  id: string;
  /** The Postgres role name. */
  name: string;
  /** ISO 8601 timestamp at which the role expires. */
  expiresAt: string | null;
  /** Hostname for the database connection. */
  host: string;
  /** Username for database authentication. */
  username: string;
  /** Password for database authentication (Redacted). */
  password: Redacted.Redacted<string>;
  /** TTL in seconds (if set). */
  ttl: number | null;
  /** The database name. */
  databaseName: string;
  /** Direct connection URL for the database (Redacted). */
  connectionUrl: Redacted.Redacted<string>;
  /** Pooled connection URL via PSBouncer (Redacted). */
  connectionUrlPooled: Redacted.Redacted<string>;
  /** Inherited roles. */
  inheritedRoles: InheritedRole[];
  /** Resolved organization slug. */
  organization: string;
  /** Resolved database name (for delete). */
  database: string;
  /** Resolved branch name. */
  branch: string;
}

/**
 * The default PlanetScale PostgreSQL role for a database branch.
 *
 * @section Creating a Default Role
 * @example Default role on the main branch
 * ```typescript
 * const db = yield* Planetscale.PostgresDatabase("MyDb", {
 *   clusterSize: "PS_10",
 * });
 * const defaultRole = yield* Planetscale.PostgresDefaultRole("MainRole", {
 *   database: db,
 *   forceReset: true,
 * });
 * ```
 */
export type PostgresDefaultRole = Resource<
  "Planetscale.PostgresDefaultRole",
  PostgresDefaultRoleProps,
  PostgresDefaultRoleAttributes,
  never,
  Providers
>;

export const PostgresDefaultRole = Resource<PostgresDefaultRole>(
  "Planetscale.PostgresDefaultRole",
);

// Structural shapes for runtime-resolved Resource references — see
// notes in Password.ts.
type DatabaseRef = string | { name: string; organization?: string };
type BranchRef = string | { name: string };

const resolveDatabaseName = (database: string | PostgresDatabase): string => {
  const ref = database as unknown as DatabaseRef;
  return typeof ref === "string" ? ref : ref.name;
};

const resolveDatabaseOrg = (
  database: string | PostgresDatabase,
): string | undefined => {
  const ref = database as unknown as DatabaseRef;
  return typeof ref === "string" ? undefined : ref.organization;
};

const resolveBranchName = (
  branch: string | PostgresBranch | undefined,
): string => {
  const ref = branch as unknown as BranchRef | undefined;
  return !ref ? "main" : typeof ref === "string" ? ref : ref.name;
};

export const PostgresDefaultRoleProvider = () =>
  Provider.effect(
    PostgresDefaultRole,
    Effect.gen(function* () {
      const getDefault = yield* ops.getDefaultRole;
      const resetDefault = yield* ops.resetDefaultRole;

      return {
        stables: ["id"],

        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;

          const newDb = resolveDatabaseName(news.database);
          const oldDb = olds.database
            ? resolveDatabaseName(olds.database)
            : undefined;
          if (oldDb && newDb !== oldDb) {
            return { action: "replace" } as const;
          }
          const newBranch = resolveBranchName(news.branch);
          const oldBranch = resolveBranchName(olds.branch);
          if (newBranch !== oldBranch) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ output }) {
          // Adoption (no cached output) is impossible without destroying
          // existing credentials. The engine routes adoption through
          // `read`, but here we always defer to reconcile so the
          // `forceReset` props flag remains the user-facing switch for
          // takeover. Returning undefined makes the engine treat the
          // resource as greenfield; reconcile then observes live state
          // and either fails (no forceReset) or resets (forceReset).
          if (!output) return undefined;

          // Refresh — verify the default role still exists and re-emit
          // the persisted output (with plaintext intact). If gone,
          // return undefined so the engine routes through reconcile,
          // which will recreate via reset.
          return yield* getDefault({
            organization: output.organization,
            database: output.database,
            branch: output.branch,
          }).pipe(
            Effect.map(() => output),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),

        reconcile: Effect.fn(function* ({ news, output }) {
          const { organization: envOrg } = yield* Credentials;
          const organization = resolveDatabaseOrg(news.database) ?? envOrg;
          const databaseName = resolveDatabaseName(news.database);
          const branchName = resolveBranchName(news.branch);

          // 1. Observe — the default role is the singleton for this
          //    (database, branch); we key on those rather than an id.
          //    Observation runs unconditionally so the adoption guard
          //    below fires on greenfield deploys against branches that
          //    already have a default role (otherwise we would silently
          //    `resetDefault` and destroy their credentials).
          const observed = yield* getDefault({
            organization,
            database: databaseName,
            branch: branchName,
          }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

          // 2. Sync (no-op) — we own the role and it still exists in the
          //    cloud. Default roles have nothing mutable in place: their
          //    plaintext password isn't retrievable, so we re-emit the
          //    persisted attributes unchanged. diff() forces a replace
          //    when database/branch change.
          if (output && observed) {
            return output;
          }

          // 3. Adoption guard — observed exists but we have no prior
          //    output (greenfield against a pre-existing default role).
          //    Taking over requires a reset (which destroys the existing
          //    password), so gate on an explicit forceReset opt-in.
          if (observed && !news.forceReset) {
            return yield* Effect.fail(
              new PlanetscaleConflict({
                message: `Default role already exists for database "${databaseName}" branch "${branchName}". Use forceReset: true to reset.`,
              }),
            );
          }

          // 4. Ensure — (re)create the default role. This branch runs
          //    for greenfield (no output, no observed), drift recovery
          //    (output cached but cloud state gone), and authorised
          //    adoption (observed present + forceReset).
          yield* waitForBranchReady(organization, databaseName, branchName);
          const data = yield* resetDefault({
            organization,
            database: databaseName,
            branch: branchName,
          });

          if (!data.password) {
            return yield* Effect.die(
              `Planetscale did not return a password for Default Role.`,
            );
          }

          const password = Redacted.isRedacted(data.password)
            ? Redacted.value(data.password)
            : data.password;

          const connectionUrl = `postgresql://${data.username}:${password}@${data.access_host_url}:5432/${data.database_name}?sslmode=verify-full`;
          const connectionUrlPooled = `postgresql://${data.username}:${password}@${data.access_host_url}:6432/${data.database_name}?sslmode=verify-full`;

          return {
            id: data.id,
            name: data.name,
            expiresAt: data.expires_at,
            host: data.access_host_url,
            username: data.username,
            password: Redacted.make(password),
            ttl: data.ttl,
            databaseName: data.database_name,
            connectionUrl: Redacted.make(connectionUrl),
            connectionUrlPooled: Redacted.make(connectionUrlPooled),
            inheritedRoles: data.inherited_roles as InheritedRole[],
            organization,
            database: databaseName,
            branch: branchName,
          } satisfies PostgresDefaultRoleAttributes;
        }),

        delete: Effect.fn(function* ({ output }) {
          // No delete endpoint — reset to invalidate existing credentials.
          yield* resetDefault({
            organization: output.organization,
            database: output.database,
            branch: output.branch,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
