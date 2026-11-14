import {
  diffMigrations,
  migrationsAttrs,
  migrationsInputOf,
  runMigrations,
  stampedOf,
  type MigrationsInput,
} from "@alchemy.run/sql/Migrations";
import { applySqlImports, hashImports, splitSqlStatements } from "@alchemy.run/sql/SqlFile";
import * as turso from "@distilled.cloud/turso/turso";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import { organization } from "./Credentials.ts";
import * as Hrana from "./Hrana.ts";
import type { Providers } from "./Providers.ts";

export class DatabaseUnexpectedResponse extends Data.TaggedError("DatabaseUnexpectedResponse")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface DatabaseSeed {
  /**
   * `"database"` copies an existing database (optionally at a point in
   * time). `"database_upload"` creates an empty database awaiting an upload
   * of a SQLite file.
   */
  type: "database" | "database_upload";
  /** Name of the source database when `type` is `"database"`. */
  name?: string;
  /**
   * ISO 8601 recovery point within the source database's retention window
   * (24 hours, or 30 days on the Scaler plan).
   */
  timestamp?: string;
}

export interface DatabaseEncryption {
  /**
   * Base64-encoded encryption key: 32 bytes for `aes256gcm`,
   * `chacha20poly1305`, and the `aegis256` variants; 16 bytes for
   * `aes128gcm` and the `aegis128l` variants.
   */
  key: Redacted.Redacted<string>;
  /** Encryption cipher. */
  cipher:
    | "aes256gcm"
    | "aes128gcm"
    | "chacha20poly1305"
    | "aegis128l"
    | "aegis128x2"
    | "aegis128x4"
    | "aegis256"
    | "aegis256x2"
    | "aegis256x4"
    | (string & {});
}

export interface DatabaseProps {
  /**
   * Database name, unique within the organization. Lowercase letters,
   * numbers, and dashes, at most 64 characters. If omitted, a unique name
   * is generated from the stack, stage, and logical ID. Changing it
   * replaces the database.
   */
  name?: string;
  /**
   * Name of the group the database is created in (e.g. `group.name`).
   * Changing it replaces the database.
   */
  group: string;
  /**
   * Seed the new database from an existing database or a pending upload.
   * Only used when the database is created.
   */
  seed?: DatabaseSeed;
  /**
   * Encrypt the database at rest with your own key. Only used when the
   * database is created; changing it replaces the database. Requires a Pro
   * or Enterprise plan.
   */
  encryption?: DatabaseEncryption;
  /**
   * Maximum size of the database, in bytes or with a unit (e.g. `"256mb"`,
   * `"1gb"`). When omitted, the current limit is left unchanged. Only
   * legacy databases support it — Turso rejects it for databases created on
   * the current platform ("size_limit is not supported for db-api
   * controlled databases").
   */
  sizeLimit?: string;
  /**
   * Allow other databases to be attached to this one with `ATTACH`. Not
   * supported on AWS-hosted databases, which reject the setting.
   * @default false
   */
  allowAttach?: boolean;
  /**
   * Reject every read query.
   * @default false
   */
  blockReads?: boolean;
  /**
   * Reject every write query.
   * @default false
   */
  blockWrites?: boolean;
  /**
   * Prevent the database from being deleted. While enabled, destroying or
   * replacing the database fails; set it to `false` and deploy first.
   * @default false
   */
  deleteProtection?: boolean;
  /**
   * IP addresses and CIDR blocks allowed to connect. Empty or omitted means
   * no IP restriction. Requires a paid plan.
   */
  allowedIps?: string[];
  /**
   * AWS VPC endpoint IDs (`vpce-...`) allowed to connect. Empty or omitted
   * means no VPC endpoint restriction. Requires a paid plan.
   */
  allowedAwsVpcIds?: string[];
  /**
   * SQL migrations to apply on deploy. Accepts a directory path, a
   * `Drizzle.Schema` resource, or `{ dir, table? }`.
   *
   * Bookkeeping lives in Alchemy's `__alchemy_migrations` table. A database
   * previously migrated by drizzle-kit is adopted by a one-way conversion on
   * first deploy.
   */
  migrations?: MigrationsInput;
  /**
   * Paths to additional `.sql` files to apply after migrations. Each file is
   * hashed; only files whose contents change are re-applied.
   */
  importFiles?: string[];
}

export interface DatabaseAttributes {
  /** Database UUID. */
  dbId: string;
  /** Database name. */
  name: string;
  /** The organization slug that owns the database. */
  organization: string;
  /** Name of the group the database belongs to. */
  group: string;
  /** DNS hostname for libSQL and HTTP connections. */
  hostname: string;
  /** libSQL connection URL (`libsql://<hostname>`), for `@libsql/client`. */
  url: string;
  /** HTTPS URL (`https://<hostname>`) of the Hrana-over-HTTP endpoint. */
  httpUrl: string;
  /** Primary location of the database. */
  primaryRegion: string;
  /** Every location the database runs in. */
  regions: string[];
  /** Maximum database size, or `undefined` when unlimited. */
  sizeLimit: string | undefined;
  /** Whether other databases may be attached. */
  allowAttach: boolean;
  /** Whether reads are blocked. */
  blockReads: boolean;
  /** Whether writes are blocked. */
  blockWrites: boolean;
  /** Whether delete protection is enabled. */
  deleteProtection: boolean;
  /** IP addresses and CIDR blocks allowed to connect. */
  allowedIps: string[];
  /** AWS VPC endpoint IDs allowed to connect. */
  allowedAwsVpcIds: string[];
  /** Directory containing migration files, if configured. */
  migrationsDir: string | undefined;
  /** Table used to track applied migrations, if configured. */
  migrationsTable: string | undefined;
  /** Content hashes for the last applied migration files. */
  migrationsHashes: Record<string, string>;
  /** Content hashes for the last applied import files. */
  importHashes: Record<string, string>;
}

export type Database = Resource<
  "Turso.Database",
  DatabaseProps,
  DatabaseAttributes,
  never,
  Providers
>;

/**
 * A Turso database: a SQLite database that lives in a {@link Group}.
 * Connect to it from a Worker or Lambda with {@link Connect}, or create a
 * {@link DatabaseToken} for other apps.
 * @see https://docs.turso.tech/concepts#databases
 *
 * ### Creating a Database
 * **Example:** Database in a group
 * ```typescript
 * const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
 * const db = yield* Turso.Database("Db", { group: group.name });
 * ```
 *
 * **Example:** Database with delete protection and an IP allowlist
 * ```typescript
 * const db = yield* Turso.Database("Db", {
 *   group: group.name,
 *   deleteProtection: true,
 *   allowedIps: ["203.0.113.0/24"],
 * });
 * ```
 *
 * ### Branching
 * **Example:** Copy an existing database
 * ```typescript
 * const preview = yield* Turso.Database("Preview", {
 *   group: group.name,
 *   seed: { type: "database", name: db.name },
 * });
 * ```
 *
 * ### Migrations
 * Point `migrations` at a folder of `.sql` files (or a `Drizzle.Schema`).
 * Pending migrations are applied in order on each deploy.
 *
 * **Example:** Apply migrations from a directory
 * ```typescript
 * const db = yield* Turso.Database("Db", {
 *   group: group.name,
 *   migrations: "./migrations",
 * });
 * ```
 *
 * **Example:** Seed with SQL files
 * ```typescript
 * const db = yield* Turso.Database("Db", {
 *   group: group.name,
 *   importFiles: ["./seed/users.sql"],
 * });
 * ```
 *
 * ### Querying from a Worker
 * **Example:** Drizzle over a Turso database
 * ```typescript
 * const conn = yield* Turso.Connect(Db);
 * const db = yield* Drizzle.LibSQL(conn);
 * ```
 *
 * @resource
 * @product Database
 */
export const Database = Resource<Database>("Turso.Database");

const databaseName = (id: string, name: string | undefined) =>
  name
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: 32, delimiter: "-" });

const rootDir = Effect.sync(() => process.cwd());

/**
 * Run `use` against a short-lived (10 minute) full-access database token,
 * for deploy-time SQL (migrations and imports).
 */
const withConnection = <A, E, R>(
  org: string,
  database: { name: string; hostname: string },
  use: (connection: Hrana.HranaConnection, client: HttpClient.HttpClient) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const { jwt } = yield* turso.createDatabaseToken({
      organizationSlug: org,
      databaseName: database.name,
      expiration: "10m",
      authorization: "full-access",
    });
    if (!jwt) {
      return yield* new DatabaseUnexpectedResponse({
        message: `Turso returned no token for ${database.name}`,
      });
    }
    return yield* use({ url: `https://${database.hostname}`, authToken: jwt }, client);
  });

export const DatabaseProvider = () =>
  Provider.effect(
    Database,
    Effect.gen(function* () {
      const observe = (org: string, name: string) =>
        turso.getDatabase({ organizationSlug: org, databaseName: name }).pipe(
          Effect.map((res) => res.database),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );

      const toAttrs = (
        org: string,
        db: turso.Database,
        config: turso.DatabaseConfigurationResponse,
        rest: Pick<
          DatabaseAttributes,
          "migrationsDir" | "migrationsTable" | "migrationsHashes" | "importHashes"
        >,
      ): DatabaseAttributes => ({
        dbId: db.DbId ?? "",
        name: db.Name!,
        organization: org,
        group: db.group ?? "",
        hostname: db.Hostname ?? "",
        url: `libsql://${db.Hostname}`,
        httpUrl: `https://${db.Hostname}`,
        primaryRegion: db.primaryRegion ?? "",
        regions: db.regions ?? [],
        sizeLimit: config.size_limit || undefined,
        allowAttach: config.allow_attach ?? false,
        blockReads: config.block_reads ?? false,
        blockWrites: config.block_writes ?? false,
        deleteProtection: config.delete_protection ?? false,
        allowedIps: config.allowed_ips ?? [],
        allowedAwsVpcIds: config.allowed_aws_vpc_ids ?? [],
        ...rest,
      });

      const getConfig = (org: string, name: string) =>
        turso.getDatabaseConfiguration({ organizationSlug: org, databaseName: name });

      return {
        stables: ["dbId", "name", "organization", "group", "hostname", "url", "httpUrl"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = output?.name ?? (yield* databaseName(id, olds?.name));
          if (news.name !== undefined && news.name !== name) {
            return { action: "replace" } as const;
          }
          if (news.group !== (output?.group ?? olds?.group)) {
            return { action: "replace", deleteFirst: news.name !== undefined } as const;
          }
          if (
            news.encryption?.cipher !== olds?.encryption?.cipher ||
            (news.encryption &&
              olds?.encryption &&
              Redacted.value(news.encryption.key) !== Redacted.value(olds.encryption.key))
          ) {
            return { action: "replace", deleteFirst: news.name !== undefined } as const;
          }
          if (yield* diffMigrations({ news, output })) {
            return { action: "update" } as const;
          }
          if (news.importFiles?.length) {
            const hashes = yield* hashImports(news.importFiles, yield* rootDir);
            if (!deepEqual(hashes, output?.importHashes ?? {})) {
              return { action: "update" } as const;
            }
          }
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          const org = output?.organization ?? (yield* organization);
          const name = output?.name ?? (yield* databaseName(id, olds?.name));
          const db = yield* observe(org, name);
          if (!db) return undefined;
          const attrs = toAttrs(org, db, yield* getConfig(org, name), {
            migrationsDir: output?.migrationsDir,
            migrationsTable: output?.migrationsTable,
            migrationsHashes: output?.migrationsHashes ?? {},
            importHashes: output?.importHashes ?? {},
          });
          // Turso has no tags: a database found under an explicit,
          // user-chosen name without prior state may belong to someone else — unless it
          // is the generation a delete-first replacement is about to free.
          const ours =
            output !== undefined ||
            olds?.name === undefined ||
            (previous?.organization === org && previous.name === name);
          return ours ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const org = output?.organization ?? (yield* organization);
          const name = output?.name ?? (yield* databaseName(id, news.name));

          // Observe
          let db = yield* observe(org, name);

          // Ensure
          if (!db) {
            yield* session.note(`Creating database ${name}...`);
            yield* turso
              .createDatabase({
                organizationSlug: org,
                name,
                group: news.group,
                seed: news.seed,
                size_limit: news.sizeLimit,
                remote_encryption: news.encryption
                  ? {
                      encryption_key: Redacted.value(news.encryption.key),
                      encryption_cipher: news.encryption.cipher,
                    }
                  : undefined,
              })
              .pipe(Effect.catchTag("Conflict", () => Effect.void));
            db = yield* observe(org, name);
            if (!db) {
              return yield* new DatabaseUnexpectedResponse({
                message: `Turso database ${name} vanished after create`,
              });
            }
          }

          // Sync configuration — diff observed settings against desired
          // and PATCH only the fields that differ.
          let config = yield* getConfig(org, name);
          const patch: Omit<turso.UpdateDatabaseConfigurationRequest, "organizationSlug"> = {
            databaseName: name,
          };
          let dirty = false;
          const set = <K extends keyof typeof patch>(
            key: K,
            observed: unknown,
            desired: (typeof patch)[K],
          ) => {
            if (!deepEqual(observed, desired)) {
              patch[key] = desired;
              dirty = true;
            }
          };
          if (news.sizeLimit !== undefined) set("size_limit", config.size_limit, news.sizeLimit);
          // AWS-hosted databases reject `allow_attach` outright, so it is
          // only sent when explicitly configured.
          if (news.allowAttach !== undefined) {
            set("allow_attach", config.allow_attach ?? false, news.allowAttach);
          }
          set("block_reads", config.block_reads ?? false, news.blockReads ?? false);
          set("block_writes", config.block_writes ?? false, news.blockWrites ?? false);
          set(
            "delete_protection",
            config.delete_protection ?? false,
            news.deleteProtection ?? false,
          );
          set("allowed_ips", config.allowed_ips ?? [], news.allowedIps ?? []);
          set("allowed_aws_vpc_ids", config.allowed_aws_vpc_ids ?? [], news.allowedAwsVpcIds ?? []);
          if (dirty) {
            config = yield* turso.updateDatabaseConfiguration({ organizationSlug: org, ...patch });
          }

          // Sync schema — migrations, then SQL imports.
          const target = { name, hostname: db.Hostname! };
          const migrationsInput = migrationsInputOf(news);
          const migrations = migrationsInput
            ? yield* runMigrations({
                input: migrationsInput,
                stamped: stampedOf(output),
                withExecutor: (apply) =>
                  withConnection(org, target, (connection, client) =>
                    apply(Hrana.makeMigrationExecutor(connection, client)),
                  ),
              })
            : undefined;

          const importHashes = yield* applySqlImports({
            importFiles: news.importFiles,
            rootDir: yield* rootDir,
            previous: output?.importHashes,
            apply: (file) =>
              session
                .note(`Importing ${file.id}...`)
                .pipe(
                  Effect.andThen(
                    withConnection(org, target, (connection, client) =>
                      Hrana.transaction(connection, splitSqlStatements(file.sql)).pipe(
                        Effect.provideService(HttpClient.HttpClient, client),
                      ),
                    ),
                  ),
                ),
          });

          return toAttrs(org, db, config, {
            ...migrationsAttrs({ input: migrationsInput, run: migrations, output }),
            importHashes,
          });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* turso
            .deleteDatabase({ organizationSlug: output.organization, databaseName: output.name })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const org = yield* organization;
          const { databases } = yield* turso.listDatabases({ organizationSlug: org });
          return (databases ?? [])
            .filter((db) => db.Name !== undefined)
            .map((db) =>
              toAttrs(
                org,
                db,
                {
                  allow_attach: db.allow_attach,
                  block_reads: db.block_reads,
                  block_writes: db.block_writes,
                  delete_protection: db.delete_protection,
                },
                {
                  migrationsDir: undefined,
                  migrationsTable: undefined,
                  migrationsHashes: {},
                  importHashes: {},
                },
              ),
            );
        }),
      };
    }),
  );
