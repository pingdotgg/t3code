import { Credentials } from "@distilled.cloud/planetscale/Credentials";
import * as planetscale from "@distilled.cloud/planetscale/Operations";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { MySQLBranch } from "./MySQLBranch.ts";
import type { MySQLDatabase } from "./MySQLDatabase.ts";
import type { MySQLOrigin } from "./MySQLOrigin.ts";

/**
 * Properties for creating or updating a PlanetScale MySQL password.
 *
 * Passwords are only meant for MySQL databases. For PostgreSQL,
 * use {@link PostgresRole} instead.
 */
export interface MySQLPasswordProps {
  /**
   * Password name. If omitted, a unique name is generated from
   * `${app}-${stage}-${id}`.
   */
  name?: string;

  /**
   * MySQL database — string name or {@link MySQLDatabase} resource.
   */
  database: string | MySQLDatabase;

  /**
   * Branch — string name or {@link MySQLBranch} resource.
   * @default "main"
   */
  branch?: string | MySQLBranch;

  /**
   * The MySQL role granted to the password.
   */
  role: "reader" | "writer" | "admin" | "readwriter";

  /**
   * Whether the password is for a read replica.
   */
  replica?: boolean;

  /**
   * Time to live (seconds). The password is invalidated after this period.
   */
  ttl?: number;

  /**
   * IP CIDR ranges allowed to use this password.
   */
  cidrs?: string[];
}

/**
 * Output attributes of a deployed PlanetScale password.
 */
export interface MySQLPasswordAttributes {
  /** Unique identifier for the password (stable). */
  id: string;
  /** Password name. If omitted, a unique name is generated from `${app}-${stage}-${id}`. */
  name: string;
  /** ISO 8601 timestamp at which the password expires. `null` if no TTL. */
  expiresAt: string | null;
  /** Hostname for the database connection. */
  host: string;
  /** Username for database authentication. */
  username: string;
  /** Password for database authentication (Redacted). */
  password: Redacted.Redacted<string>;
  /** Parsed connection components ready to feed into Cloudflare Hyperdrive. */
  origin: MySQLOrigin;
  /** Resolved organization slug. */
  organization: string;
  /** Resolved database name. */
  database: string;
  /** Resolved branch name. */
  branch: string;
  /** The role granted. */
  role: "reader" | "writer" | "admin" | "readwriter";
  /** Whether this password is for a read replica. */
  replica: boolean | undefined;
  /** TTL in seconds (if set). */
  ttl: number | undefined;
  /** IP CIDR ranges allowed to use this password. */
  cidrs: readonly string[] | undefined;
}

/**
 * A PlanetScale password for accessing a MySQL database branch.
 *
 * For PostgreSQL databases, use {@link PostgresRole} instead.
 *
 * @section Creating a Password
 * @example Reader password
 * ```typescript
 * const reader = yield* Planetscale.MySQLPassword("AppReader", {
 *   database: "my-db",
 *   role: "reader",
 * });
 * ```
 *
 * @example Writer password with TTL
 * ```typescript
 * const writer = yield* Planetscale.MySQLPassword("AppWriter", {
 *   database: "my-db",
 *   role: "writer",
 *   ttl: 86400,
 * });
 * ```
 *
 * @example Admin password with IP allowlist
 * ```typescript
 * const admin = yield* Planetscale.MySQLPassword("Admin", {
 *   database: "my-db",
 *   role: "admin",
 *   cidrs: ["203.0.113.0/24", "198.51.100.0/24"],
 * });
 * ```
 */
export type MySQLPassword = Resource<
  "Planetscale.MySQLPassword",
  MySQLPasswordProps,
  MySQLPasswordAttributes,
  never,
  Providers
>;

/** @resource */
export const MySQLPassword = Resource<MySQLPassword>(
  "Planetscale.MySQLPassword",
);

export const MySQLPasswordProvider = () =>
  Provider.succeed(MySQLPassword, {
    stables: ["id"],
    diff: Effect.fn(function* ({ olds = {}, news }) {
      if (!isResolved(news)) return undefined;

      // Replace on any immutable-in-place change; engine falls through
      // to reconcile for everything else (which authoritatively diffs
      // against observed cloud state).
      if (news.role !== olds.role) return { action: "replace" } as const;
      if (news.replica !== olds.replica) {
        return { action: "replace" } as const;
      }
      if (news.ttl !== olds.ttl) return { action: "replace" } as const;

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
      // Adoption (no cached output) is impossible: the PlanetScale API
      // never re-issues plaintext, so even if we found a matching live
      // password by listing+name we couldn't deliver the `password`
      // attribute. Fall through to greenfield create in `reconcile`.
      if (!output) return undefined;

      // Refresh — verify the cached password still exists and
      // re-emit the persisted output (with plaintext intact).
      // If it's gone, return undefined so the engine routes to
      // reconcile, which will surface the unrecoverable-rotation
      // condition explicitly.
      return yield* planetscale
        .getPassword({
          organization: output.organization,
          database: output.database,
          branch: output.branch,
          id: output.id,
        })
        .pipe(
          Effect.map((password) =>
            buildAttributes(password, output.password, {
              organization: output.organization,
              database: output.database,
              branch: output.branch,
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const newName = yield* createPasswordName(id, news.name);

      // Identifiers — stable across update (diff replaces on
      // database/branch changes), so we can pull from `output` first
      // and fall back to `news` for greenfield.
      const { organization: envOrg } = yield* yield* Credentials;
      const organization =
        output?.organization ?? resolveDatabaseOrg(news.database) ?? envOrg;
      const databaseName =
        output?.database ?? resolveDatabaseName(news.database);
      const branchName = output?.branch ?? resolveBranchName(news.branch);

      // 1. Observe — read live state. The PlanetScale API has no
      //    "lookup by name" path (names aren't unique within a branch)
      //    so the only way to find the live password is by id. Without
      //    a cached output we cannot observe and fall straight through
      //    to ensure (greenfield create).
      const observed = output
        ? yield* planetscale
            .getPassword({
              organization,
              database: databaseName,
              branch: branchName,
              id: output.id,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)))
        : undefined;

      // 2. Ensure — create the password if it doesn't exist live.
      //    This single branch covers greenfield (no output) AND the
      //    out-of-band-deletion case (output cached but cloud lost it).
      //    The latter is structurally a rotation: the new password
      //    has a fresh id/host/username/plaintext that propagate
      //    downstream through the dependency graph. There is no path
      //    to recover the original plaintext, so recreating is the
      //    only way to converge.
      let live: planetscale.GetPasswordOutput;
      let plaintext: Redacted.Redacted<string>;
      if (observed) {
        live = observed;
        // We re-use the cached plaintext: the API never re-issues it.
        plaintext = output!.password;
      } else {
        const created = yield* planetscale.createPassword({
          organization,
          database: databaseName,
          branch: branchName,
          name: newName,
          role: news.role,
          replica: news.replica,
          ttl: news.ttl,
          cidrs: news.cidrs,
        });
        plaintext = created.plain_text;
        live = created;
      }

      // 3. Sync — diff observed cloud state against desired and patch
      //    only what changed. Only `name` and `cidrs` are mutable in
      //    place; everything else triggers a replace via diff().
      //    Skip the API entirely when there's no delta.
      const wantsRename = newName !== live.name;
      const observedCidrs = normalizeCidrs(live.cidrs);
      const desiredCidrs = normalizeCidrs(news.cidrs);
      const wantsCidrs = !deepEqual(desiredCidrs, observedCidrs);

      if (wantsRename || wantsCidrs) {
        live = yield* planetscale.updatePassword({
          organization,
          database: databaseName,
          branch: branchName,
          id: live.id,
          name: wantsRename ? newName : undefined,
          cidrs: wantsCidrs ? news.cidrs : undefined,
        });
      }

      // 4. Return — fresh attrs sourced from observed cloud state,
      //    re-using cached plaintext when we didn't just create.
      return buildAttributes(live, plaintext, {
        organization,
        database: databaseName,
        branch: branchName,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* planetscale
        .deletePassword({
          organization: output.organization,
          database: output.database,
          branch: output.branch,
          id: output.id,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: Effect.fn(function* () {
      const { organization } = yield* yield* Credentials;

      const databases = yield* planetscale.listDatabases
        .pages({ organization })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              page.data.filter((db) => db.kind === "mysql"),
            ),
          ),
        );

      const rows = yield* Effect.forEach(
        databases,
        (db) =>
          planetscale.listBranches
            .pages({ organization, database: db.name })
            .pipe(
              Stream.runCollect,
              Effect.map((branchPages) =>
                Array.from(branchPages).flatMap((page) =>
                  page.data.filter((branch) => branch.kind === "mysql"),
                ),
              ),
              Effect.catchTag("NotFound", () =>
                Effect.succeed([{ name: db.default_branch ?? "main" }]),
              ),
              Effect.flatMap((branches) =>
                Effect.forEach(
                  branches,
                  (branch) =>
                    planetscale.listPasswords
                      .pages({
                        organization,
                        database: db.name,
                        branch: branch.name,
                      })
                      .pipe(
                        Stream.runCollect,
                        Effect.map((passwordPages): MySQLPasswordAttributes[] =>
                          Array.from(passwordPages).flatMap((page) =>
                            page.data.map((password) =>
                              buildAttributes(password, Redacted.make(""), {
                                organization,
                                database: db.name,
                                branch: branch.name,
                              }),
                            ),
                          ),
                        ),
                        Effect.catchTag("NotFound", () =>
                          Effect.succeed([] as MySQLPasswordAttributes[]),
                        ),
                      ),
                  { concurrency: 10 },
                ).pipe(Effect.map((perBranch) => perBranch.flat())),
              ),
            ),
        { concurrency: 10 },
      );

      return rows.flat();
    }),
  });

// At runtime, Resource references in props are resolved to their full
// attributes — so `news.database` (when a Database resource was passed)
// is `{ name: string; organization: string; ... }` rather than the
// statically-typed Resource (whose attributes are `Output<...>`). We
// cast through structural shapes here.
type DatabaseRef = string | { name: string; organization?: string };
type BranchRef = string | { name: string };

const resolveDatabaseName = (database: string | MySQLDatabase): string => {
  const ref = database as unknown as DatabaseRef;
  return typeof ref === "string" ? ref : ref.name;
};

const resolveDatabaseOrg = (
  database: string | MySQLDatabase,
): string | undefined => {
  const ref = database as unknown as DatabaseRef;
  return typeof ref === "string" ? undefined : ref.organization;
};

const resolveBranchName = (
  branch: string | MySQLBranch | undefined,
): string => {
  const ref = branch as unknown as BranchRef | undefined;
  return !ref ? "main" : typeof ref === "string" ? ref : ref.name;
};

const createPasswordName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return (
      name ??
      (yield* createPhysicalName({ id, lowercase: true, maxLength: 63 }))
    );
  });

// Normalize the API's nullable `cidrs` field into the `string[] | undefined`
// shape we persist so downstream comparisons line up regardless of the
// API returning `null` vs `[]` vs an actual list.
const normalizeCidrs = (
  cidrs: readonly string[] | null | undefined,
): readonly string[] | undefined =>
  cidrs == null || cidrs.length === 0 ? undefined : cidrs;

const buildAttributes = (
  password: {
    id: string;
    name: string;
    expires_at: string | null;
    access_host_url: string;
    username: string;
    role: "reader" | "writer" | "admin" | "readwriter";
    replica: boolean;
    ttl_seconds: number | null;
    cidrs: readonly string[] | null;
  },
  plaintext: Redacted.Redacted<string>,
  context: {
    organization: string;
    database: string;
    branch: string;
  },
): MySQLPasswordAttributes => ({
  id: password.id,
  name: password.name,
  expiresAt: password.expires_at,
  host: password.access_host_url,
  username: password.username,
  password: plaintext,
  origin: {
    scheme: "mysql",
    host: password.access_host_url,
    port: 3306,
    database: context.database,
    user: password.username,
    password: plaintext,
  },
  organization: context.organization,
  database: context.database,
  branch: context.branch,
  role: password.role,
  replica: password.replica,
  ttl: password.ttl_seconds ?? undefined,
  cidrs: normalizeCidrs(password.cidrs),
});
