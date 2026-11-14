import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/turso/Credentials";
import * as turso from "@distilled.cloud/turso/turso";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { ApiToken } from "./ApiToken.ts";
import type { ConnectClient } from "./Connect.ts";
import type { DatabaseSeed } from "./Database.ts";
import type { Group } from "./Group.ts";
import { GroupToken } from "./GroupToken.ts";

/** A database in the managed group. */
export interface ManagedDatabase {
  /** Database name. */
  name: string;
  /** Database UUID. */
  dbId: string;
  /** DNS hostname of the database. */
  hostname: string;
  /** libSQL URL (`libsql://<hostname>`). */
  url: string;
}

export interface CreateManagedDatabaseOptions {
  /** Seed the new database from an existing database (e.g. a template). */
  seed?: DatabaseSeed;
  /** Maximum size of the database, e.g. `"256mb"`. */
  sizeLimit?: string;
}

export interface ManageDatabasesClient {
  /** Create a database in the group. */
  create(
    name: string,
    options?: CreateManagedDatabaseOptions,
  ): Effect.Effect<ManagedDatabase, turso.CreateDatabaseError, RuntimeContext>;
  /** Look up a database by name; `undefined` when it doesn't exist. */
  get(
    name: string,
  ): Effect.Effect<ManagedDatabase | undefined, turso.GetDatabaseError, RuntimeContext>;
  /** List every database in the group. */
  list(): Effect.Effect<ManagedDatabase[], turso.ListDatabasesError, RuntimeContext>;
  /** Delete a database. Deleting a missing database succeeds. */
  delete(name: string): Effect.Effect<void, turso.DeleteDatabaseError, RuntimeContext>;
  /**
   * libSQL connection accessors for a database in the group, authorized by
   * a group-wide SQL token. Pass to `SQL.LibSQL` or `Drizzle.LibSQL`.
   */
  connect(name: string): ConnectClient;
}

/**
 * Let a Worker create, list, delete, and query databases in one Turso
 * {@link Group}. Use it to give each customer their own database.
 *
 * The Worker gets an {@link ApiToken} that only works on that group, and a
 * {@link GroupToken} for running SQL. It can't touch databases in any other
 * group, and your own Turso API token stays on your machine.
 *
 * ### Database per tenant
 * **Example:** Create a tenant database on signup and query it
 * ```typescript
 * Effect.gen(function* () {
 *   const tenants = yield* Turso.ManageDatabases(Tenants);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const db = yield* tenants.create("acme");
 *       const sql = yield* SQL.LibSQL(tenants.connect(db.name));
 *       yield* sql`CREATE TABLE IF NOT EXISTS notes (body TEXT)`;
 *       return HttpServerResponse.text(db.url);
 *     }),
 *   };
 * }).pipe(Effect.provide(Turso.ManageDatabasesHttp));
 * ```
 *
 * @binding
 * @product Group
 */
export interface ManageDatabases extends Binding.Service<
  ManageDatabases,
  "Turso.ManageDatabases",
  (group: Group) => Effect.Effect<ManageDatabasesClient>
> {}

export const ManageDatabases = Binding.Service<ManageDatabases>("Turso.ManageDatabases");

/** Implementation over the Turso Platform API, usable from any Platform host. */
export const ManageDatabasesHttp = Layer.effect(
  ManageDatabases,
  Effect.gen(function* () {
    const PlatformToken = yield* ApiToken;
    const SqlToken = yield* GroupToken;
    return Effect.fn(function* (group: Group) {
      const host = yield* Binding.Host;
      const prefix = `${host?.LogicalId ?? ""}${group.LogicalId}`;
      const apiToken = yield* PlatformToken(`${prefix}ManageToken`, {
        group: group.name,
        scopes: ["read", "db:create", "db:delete", "db:configure"],
      });
      const sqlToken = yield* SqlToken(`${prefix}SqlToken`, {
        group: group.name,
      });
      const apiKey = yield* apiToken.token;
      const authToken = yield* sqlToken.token;
      const organization = yield* group.organization;
      const groupName = yield* group.name;
      const location = yield* group.location;

      const authorize = <A, E>(
        effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
      ): Effect.Effect<A, E, RuntimeContext> =>
        effect.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(
                Credentials,
                Effect.map(apiKey, (key) => ({ apiKey: key, apiBaseUrl: DEFAULT_API_BASE_URL })),
              ),
              FetchHttpClient.layer,
            ),
          ),
        );

      const toManaged = (db: {
        Name?: string;
        DbId?: string;
        Hostname?: string;
      }): ManagedDatabase => ({
        name: db.Name ?? "",
        dbId: db.DbId ?? "",
        hostname: db.Hostname ?? "",
        url: `libsql://${db.Hostname}`,
      });

      const client: ManageDatabasesClient = {
        create: (name, options) =>
          authorize(
            Effect.gen(function* () {
              const { database } = yield* turso.createDatabase({
                organizationSlug: yield* organization,
                name,
                group: yield* groupName,
                seed: options?.seed,
                size_limit: options?.sizeLimit,
              });
              return toManaged(database ?? {});
            }),
          ),
        get: (name) =>
          authorize(
            Effect.gen(function* () {
              const { database } = yield* turso.getDatabase({
                organizationSlug: yield* organization,
                databaseName: name,
              });
              return database && database.group === (yield* groupName)
                ? toManaged(database)
                : undefined;
            }).pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
          ),
        list: () =>
          authorize(
            Effect.gen(function* () {
              const { databases } = yield* turso.listDatabases({
                organizationSlug: yield* organization,
                group: yield* groupName,
              });
              return (databases ?? []).map(toManaged);
            }),
          ),
        delete: (name) =>
          authorize(
            Effect.gen(function* () {
              yield* turso.deleteDatabase({
                organizationSlug: yield* organization,
                databaseName: name,
              });
            }).pipe(Effect.catchTag("NotFound", () => Effect.void)),
          ),
        connect: (name) => ({
          // Turso hostnames are `<database>-<organization>.<location>.turso.io`,
          // so the URL is derived without a Platform API round-trip.
          url: Effect.gen(function* () {
            return `libsql://${name}-${yield* organization}.${yield* location}.turso.io`;
          }),
          authToken,
        }),
      };
      return client;
    });
  }),
);
