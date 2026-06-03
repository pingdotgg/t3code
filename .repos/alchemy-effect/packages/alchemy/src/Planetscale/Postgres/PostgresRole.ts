import { Credentials } from "@distilled.cloud/planetscale/Credentials";
import * as ops from "@distilled.cloud/planetscale/Operations";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  isKnownError,
  PlanetscaleConflict,
  waitForBranchReady,
} from "../Util.ts";
import type { PostgresBranch } from "./PostgresBranch.ts";
import type { PostgresDatabase } from "./PostgresDatabase.ts";
import type { PostgresOrigin } from "./PostgresOrigin.ts";
import { createPhysicalName } from "../../PhysicalName.ts";

/**
 * Built-in PostgreSQL roles that can be inherited from. Custom role names
 * (referencing other Role resources) are also accepted.
 */
export type InheritedRole =
  | "pscale_managed"
  | "pg_checkpoint"
  | "pg_create_subscription"
  | "pg_maintain"
  | "pg_monitor"
  | "pg_read_all_data"
  | "pg_read_all_settings"
  | "pg_read_all_stats"
  | "pg_signal_backend"
  | "pg_stat_scan_tables"
  | "pg_use_reserved_connections"
  | "pg_write_all_data"
  | "postgres"
  | (string & {});

type SDKInheritedRole =
  | "pscale_managed"
  | "pg_checkpoint"
  | "pg_create_subscription"
  | "pg_maintain"
  | "pg_monitor"
  | "pg_read_all_data"
  | "pg_read_all_settings"
  | "pg_read_all_stats"
  | "pg_signal_backend"
  | "pg_stat_scan_tables"
  | "pg_use_reserved_connections"
  | "pg_write_all_data"
  | "postgres";

/**
 * Properties for creating or updating a PlanetScale PostgreSQL role.
 *
 * Roles are only meant for PostgreSQL databases. For MySQL,
 * use {@link MySQLPassword} instead.
 */
export interface PostgresRoleProps {
  /**
   * Role name. If not provided, a physical name will be generated.
   */
  name?: string;
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
   * Time to live in seconds.
   */
  ttl?: number;

  /**
   * Roles to inherit from. Either a list of built-in role names, or
   * another {@link PostgresRole} resource (whose `inheritedRoles` are reused).
   */
  inheritedRoles: InheritedRole[] | PostgresRole;

  /**
   * Successor role to reassign ownership to before dropping. Used during
   * delete.
   * @default "postgres"
   */
  successor?: string | PostgresRole;
}

/**
 * Output attributes of a deployed PlanetScale role.
 */
export interface PostgresRoleAttributes {
  /** Unique identifier for the role (stable). */
  id: string;
  /** The Postgres role name (assigned by PlanetScale). */
  name: string;
  /** ISO 8601 timestamp at which the role expires. */
  expiresAt: string | null;
  /** Hostname for the database connection. */
  host: string;
  /** Username for database authentication. */
  username: string;
  /** Password for database authentication (Redacted). */
  password: Redacted.Redacted<string>;
  /** The database name. */
  database: string;
  /** The Postgres database name inside the branch. */
  databaseName: string;
  /** Parsed connection components ready to feed into Cloudflare Hyperdrive. */
  origin: PostgresOrigin;
  /** Direct connection URL for the database (Redacted). */
  connectionUrl: Redacted.Redacted<string>;
  /** Pooled connection URL via PSBouncer (port 6432, Redacted). */
  connectionUrlPooled: Redacted.Redacted<string>;
  /** Inherited roles. */
  inheritedRoles: InheritedRole[];
  /** The successor role used during delete. */
  successor: string;
  /** Resolved organization slug. */
  organization: string;
  /** Resolved branch name. */
  branch: string;
  /** Time-to-live for the role in seconds. */
  ttl: number | null;
}

/**
 * A PlanetScale role for accessing a PostgreSQL database branch.
 *
 * For MySQL databases, use {@link MySQLPassword} instead.
 *
 * @section Creating a Role
 * @example Postgres admin role
 * ```typescript
 * const admin = yield* Planetscale.PostgresRole("Admin", {
 *   database: "my-db",
 *   inheritedRoles: ["postgres"],
 * });
 * ```
 *
 * @example Read-only role
 * ```typescript
 * const reader = yield* Planetscale.PostgresRole("Reader", {
 *   database: "my-db",
 *   inheritedRoles: ["pg_read_all_data", "pg_read_all_settings"],
 * });
 * ```
 *
 * @example Role with TTL
 * ```typescript
 * const tempReader = yield* Planetscale.PostgresRole("TempReader", {
 *   database: "my-db",
 *   inheritedRoles: ["pg_read_all_data"],
 *   ttl: 3600,
 * });
 * ```
 */
export type PostgresRole = Resource<
  "Planetscale.PostgresRole",
  PostgresRoleProps,
  PostgresRoleAttributes,
  never,
  Providers
>;

export const PostgresRole = Resource<PostgresRole>("Planetscale.PostgresRole");

// Structural shapes for runtime-resolved Resource references — see notes
// in Password.ts.
type DatabaseRef = string | { name: string; organization?: string };
type BranchRef = string | { name: string };
type RoleRef = string | { name: string; inheritedRoles: InheritedRole[] };

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

const resolveSuccessorName = (
  successor: string | PostgresRole | undefined,
): string => {
  const ref = successor as unknown as RoleRef | undefined;
  return !ref ? "postgres" : typeof ref === "string" ? ref : ref.name;
};

const resolveInheritedRoles = (
  inheritedRoles: InheritedRole[] | PostgresRole,
): InheritedRole[] => {
  if (Array.isArray(inheritedRoles)) {
    return inheritedRoles;
  }
  // At runtime, a Role passed in is its resolved attributes (with
  // `inheritedRoles` as a plain array); statically `Role.inheritedRoles`
  // is `Output<InheritedRole[]>`.
  return (
    inheritedRoles as unknown as RoleRef as { inheritedRoles: InheritedRole[] }
  ).inheritedRoles;
};

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return (
      name ??
      (yield* createPhysicalName({ id, lowercase: true, maxLength: 63 }))
    );
  });

const buildAttributes = (
  role: {
    id: string;
    name: string;
    expires_at: string | null;
    access_host_url: string;
    username: string;
    database_name: string;
    ttl: number | null;
  },
  password: Redacted.Redacted<string>,
  context: {
    inheritedRoles: InheritedRole[];
    successor: string;
    organization: string;
    database: string;
    branch: string;
  },
): PostgresRoleAttributes => {
  const passwordValue = Redacted.value(password);
  const connectionUrl = `postgresql://${role.username}:${passwordValue}@${role.access_host_url}:5432/${role.database_name}?sslmode=verify-full`;
  const connectionUrlPooled = `postgresql://${role.username}:${passwordValue}@${role.access_host_url}:6432/${role.database_name}?sslmode=verify-full`;

  return {
    id: role.id,
    name: role.name,
    expiresAt: role.expires_at,
    host: role.access_host_url,
    username: role.username,
    password,
    connectionUrl: Redacted.make(connectionUrl),
    connectionUrlPooled: Redacted.make(connectionUrlPooled),
    inheritedRoles: context.inheritedRoles,
    successor: context.successor,
    organization: context.organization,
    database: context.database,
    databaseName: role.database_name,
    origin: {
      scheme: "postgres",
      host: role.access_host_url,
      port: 5432,
      database: role.database_name,
      user: role.username,
      password,
    },
    branch: context.branch,
    ttl: role.ttl,
  };
};

export const PostgresRoleProvider = () =>
  Provider.effect(
    PostgresRole,
    Effect.gen(function* () {
      const createRole = yield* ops.createRole;
      const deleteRole = yield* ops.deleteRole;
      const updateRole = yield* ops.updateRole;
      const getRole = yield* ops.getRole;
      const getBranch = yield* ops.getBranch;

      return {
        stables: ["id"],

        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return undefined;

          // Successor is the only updatable property — everything else
          // requires replacement.
          if (news.ttl !== olds.ttl) {
            return { action: "replace" } as const;
          }
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
          const newRoles = resolveInheritedRoles(news.inheritedRoles);
          const oldRoles = output?.inheritedRoles ?? [];
          if (!deepEqual(newRoles, oldRoles)) {
            return { action: "replace" } as const;
          }
          const oldName = output?.name ?? (yield* resolveName(id, olds?.name));
          const newName = yield* resolveName(id, news.name);

          if (newName !== oldName) {
            return { action: "update" } as const;
          }

          return undefined;
        }),

        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;

          return yield* getRole({
            branch: output.branch,
            database: output.database,
            organization: output.organization,
            id: output.id,
          }).pipe(
            Effect.map((token) =>
              buildAttributes(token, output.password, {
                inheritedRoles: token.inherited_roles as InheritedRole[],
                successor: output.successor,
                organization: output.organization,
                database: output.database,
                branch: token.branch.name,
              }),
            ),
            Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const { organization: envOrg } = yield* Credentials;
          const organization = resolveDatabaseOrg(news.database) ?? envOrg;
          const databaseName = resolveDatabaseName(news.database);
          const branchName = resolveBranchName(news.branch);
          const inheritedRoles = resolveInheritedRoles(news.inheritedRoles);
          const successor = resolveSuccessorName(news.successor);
          const desiredName = yield* resolveName(id, news.name);

          // 1. Observe — fetch live state if we know the role id. Roles
          //    can only be looked up by id; without a cached id there is
          //    no way to find the live role, so we fall through to ensure.
          const observed = output?.id
            ? yield* getRole({
                id: output.id,
                branch: branchName,
                organization,
                database: databaseName,
              }).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : undefined;

          // 2. Ensure — create if missing. Single branch covers both
          //    greenfield (no output) and out-of-band-deletion (output
          //    cached but cloud lost it). The latter is structurally a
          //    rotation: the new role has fresh id/host/username/plaintext
          //    that propagate downstream through the dependency graph.
          //    There is no path to recover the original plaintext, so
          //    recreating is the only way to converge.
          //
          //    Planetscale returns the plaintext password value exactly
          //    once on create; on an observe-hit we re-use the cached
          //    plaintext from output (which is why adoption requires
          //    pre-existing state — see `read`).
          let live: ops.GetRoleOutput | ops.CreateRoleOutput;
          let plaintext: Redacted.Redacted<string>;
          if (observed) {
            live = observed;
            plaintext = output!.password;
          } else {
            const branchInfo = yield* getBranch({
              organization,
              database: databaseName,
              branch: branchName,
            });
            if (branchInfo.kind !== "postgresql") {
              return yield* Effect.fail(
                new PlanetscaleConflict({
                  message: `Cannot create a Role on MySQL database "${databaseName}". Roles are only supported on PostgreSQL. Use Password for MySQL.`,
                }),
              );
            }
            if (!branchInfo.ready) {
              yield* waitForBranchReady(organization, databaseName, branchName);
            }
            const created = yield* createRole({
              name: desiredName,
              branch: branchName,
              organization,
              database: databaseName,
              ttl: news.ttl,
              inherited_roles: inheritedRoles as SDKInheritedRole[],
            });
            if (!created.password) {
              return yield* Effect.die(
                `Planetscale did not return a password for Role "${desiredName}".`,
              );
            }
            plaintext = created.password;
            live = created;
          }

          // 3. Sync — only `name` is mutable in place; diff observed
          //    against desired and skip the API call when nothing
          //    changed. Everything else triggers a replace via diff().
          if (live.name !== desiredName) {
            live = yield* updateRole({
              id: live.id,
              branch: branchName,
              organization,
              database: databaseName,
              name: desiredName,
            });
          }

          // 4. Return — fresh attrs sourced from observed cloud state,
          //    with cached or freshly-issued plaintext.
          return buildAttributes(live, plaintext, {
            inheritedRoles: live.inherited_roles as InheritedRole[],
            successor,
            organization,
            database: databaseName,
            branch: branchName,
          });
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* deleteRole({
            organization: output.organization,
            database: output.database,
            branch: output.branch,
            id: output.id,
            successor: output.successor,
          }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            // 422 (UnprocessableEntity): role is still referenced. Log a
            // warning rather than failing — the role will be cleaned up
            // when the database/branch is deleted.
            Effect.catchIf(
              isKnownError(
                "UnprocessableEntity",
                "Role is still referenced and cannot be dropped.",
              ),
              () => Effect.void,
            ),
          );
        }),
      };
    }),
  );
