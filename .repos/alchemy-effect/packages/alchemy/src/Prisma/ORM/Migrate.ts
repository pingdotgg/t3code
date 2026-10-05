import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  isTransientDbError,
  type MigrateResult,
  type MigrateShowResult,
  readMigrationPackages,
  resolveGraphHead,
  runPrismaCli,
} from "./internal.ts";

export type MigrateProps = {
  /**
   * Postgres connection string of the database to migrate. Accepts the
   * redacted connection outputs produced by database resources (e.g.
   * `branch.origin.connectionString`, `database.directConnectionString`).
   */
  url: Redacted.Redacted<string> | string;
  /**
   * The {@link Contract} this database tracks. Passing the contract's output
   * both orders the deploy (plan migrations before applying them) and drives
   * the diff: the database is up to date exactly when its marker hash equals
   * `contract.contractHash`.
   */
  contract: {
    /** The emitted contract's storage hash (see {@link Contract}). */
    contractHash: string;
    /** Path to `prisma.config.ts`, relative to the current working directory. */
    config: string;
    /** Migration graph directory, relative to the current working directory. */
    migrationsDir: string;
  };
  /**
   * Path to the project's `prisma.config.ts`, relative to the current
   * working directory. Defaults to the config the {@link Contract} was
   * emitted from.
   *
   * @default contract.config
   */
  config?: string;
  /**
   * Target contract reference (hash, prefix, ref name, or migration dir
   * name) to migrate to instead of the graph head. Useful for pinning an
   * environment to a signed-off contract.
   */
  to?: string;
};

export type Migrate = Resource<
  "Prisma.Migrate",
  MigrateProps,
  {
    /**
     * The database marker's contract hash after the last apply — the
     * database's current contract identity, equal to the target contract's
     * `contractHash` when converged.
     */
    markerHash: string;
  },
  never,
  Providers
>;

/**
 * Applies pending Prisma migration packages to a Postgres database
 * during `alchemy deploy` — the deploy-graph equivalent of running
 * `prisma db migrate --db $DATABASE_URL` by hand.
 *
 * The apply is idempotent: Prisma records the applied contract in the
 * database's `prisma_contract.marker` table and only walks the pending part
 * of the migration graph, so re-deploys are no-ops and a database
 * provisioned in the same deploy is bootstrapped from empty. Fresh databases
 * that are still coming up are retried briefly (bounded) before failing.
 *
 * Destroying the resource never touches the database — dropping tables is
 * not the IaC engine's call to make.
 *
 * ### Migrating a database on deploy
 * **Example:** Neon branch
 * ```typescript
 * const contract = yield* Prisma.Contract("contract");
 * const project = yield* Neon.Project("db");
 * const branch = yield* Neon.Branch("main", { project });
 *
 * yield* Prisma.Migrate("migrate", {
 *   url: branch.origin.connectionString,
 *   contract,
 * });
 * ```
 *
 * **Example:** Prisma Postgres
 * ```typescript
 * const contract = yield* Prisma.Contract("contract");
 * const database = yield* Prisma.Database("db", { project });
 *
 * yield* Prisma.Migrate("migrate", {
 *   url: database.directConnectionString,
 *   contract,
 * });
 * ```
 *
 * **Example:** Pinning an environment to a contract ref
 * ```typescript
 * yield* Prisma.Migrate("migrate", {
 *   url: branch.origin.connectionString,
 *   contract,
 *   to: "production",
 * });
 * ```
 *
 * @resource
 * @category ORM
 */
export const Migrate = Resource<Migrate>("Prisma.Migrate");

const urlValue = (url: Redacted.Redacted<string> | string): string =>
  Redacted.isRedacted(url) ? Redacted.value(url) : url;

export const MigrateProvider = () =>
  Provider.effect(
    Migrate,
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const resolveConfig = (p: MigrateProps) =>
        path.resolve(
          process.cwd(),
          p.config ?? p.contract.config ?? "./prisma.config.ts",
        );

      const configDir = (p: MigrateProps) => path.dirname(resolveConfig(p));

      return {
        // Non-listable: the marker row lives inside an arbitrary database
        // reachable only through the props' connection string — there is no
        // account-level API to enumerate migrated databases.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          // The database is converged when its marker matches the contract
          // the props point at; anything else (new migration planned, marker
          // reset, database recreated out-of-band) is an update. `reconcile`
          // observes the real database, so update is always safe.
          return news.contract.contractHash !== output.markerHash
            ? { action: "update" }
            : undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (!output || !olds) return output;
          // `db migrate --show` is a read-only preview of the pending path
          // from the database's current marker. An empty path means the marker is
          // at the on-disk graph head; otherwise the first pending package's
          // `from` IS the marker ("empty" = database was never initialized).
          const show = yield* runPrismaCli<MigrateShowResult>(
            [
              "db",
              "migrate",
              "--show",
              "--db",
              urlValue(olds.url),
              "--config",
              resolveConfig(olds),
            ],
            { cwd: configDir(olds) },
          ).pipe(
            // An unreachable database is not evidence the resource is gone —
            // keep the last observed state rather than failing refresh.
            Effect.catchTag("Prisma.CliError", () => Effect.succeed(undefined)),
          );
          if (show === undefined) return output;
          const pending = show.migrations;
          if (pending.length === 0) {
            const packages = yield* readMigrationPackages(
              path.resolve(process.cwd(), olds.contract.migrationsDir),
            );
            const head = resolveGraphHead(packages);
            return { markerHash: head?.to ?? output.markerHash };
          }
          const marker = pending[0]?.from;
          if (marker === undefined || marker === "empty") return undefined;
          return { markerHash: marker };
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          yield* session.note(
            `Applying Prisma migrations (target ${news.contract.contractHash.slice(0, 8)})`,
          );
          const result = yield* runPrismaCli<MigrateResult>(
            [
              "db",
              "migrate",
              "--db",
              urlValue(news.url),
              "--config",
              resolveConfig(news),
              ...(news.to ? ["--to", news.to] : []),
            ],
            { cwd: configDir(news) },
          ).pipe(
            // A database provisioned earlier in this deploy may still be
            // warming up — retry connection-flavored failures briefly.
            Effect.retry({
              while: (error) => isTransientDbError(error),
              schedule: Schedule.exponential("1 second"),
              times: 5,
            }),
          );
          yield* session.note(
            result.migrationsApplied > 0
              ? `Applied ${result.migrationsApplied} migration(s) → ${result.markerHash.slice(0, 8)}`
              : "Database already up to date",
          );
          return { markerHash: result.markerHash };
        }),
        delete: Effect.fn(function* () {
          // Never drop tables or unwind migrations on teardown — the
          // database's contents outlive the stack by design.
        }),
      };
    }),
  );
