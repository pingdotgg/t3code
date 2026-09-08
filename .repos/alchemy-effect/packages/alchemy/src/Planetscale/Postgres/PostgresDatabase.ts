import { Credentials } from "@distilled.cloud/planetscale/Credentials";
import * as planetscale from "@distilled.cloud/planetscale";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { havePropsChanged, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hashImports, hashMigrations } from "../../SQL/SqlFile.ts";
import {
  diffMigrations,
  migrationsAttrs,
  migrationsInputOf,
  stampedOf,
} from "../../SQL/Migrations/index.ts";
import { recordsEqual } from "../../Util/equal.ts";
import type { BaseDatabaseAttributes, BaseDatabaseProps } from "../Database.ts";
import type { Providers } from "../Providers.ts";
import {
  PlanetscaleConflict,
  waitForBranchReady,
  waitForDatabaseReady,
} from "../Util.ts";
import {
  ensurePostgresProductionBranchClusterSize,
  toPostgresClusterSku,
  type PostgresClusterSize,
} from "./PostgresClusterSize.ts";
import {
  runPostgresImports,
  runPostgresMigrations,
} from "./PostgresMigrations.ts";

/**
 * Properties for creating or updating a PostgreSQL PlanetScale database.
 */
export interface PostgresDatabaseProps extends BaseDatabaseProps {
  /**
   * The PostgreSQL database cluster size. Required.
   *
   * Short NAS sizes (`"PS_10"`) are expanded using the target region and
   * architecture. [PlanetScale Metal](https://planetscale.com/docs/metal)
   * requires the full SKU (e.g. `"M1_10_AWS_ARM_D_METAL_10"`) because
   * Metal also encodes CPU series, architecture, and NVMe drive size.
   *
   * @see https://planetscale.com/docs/postgres/pricing
   * @see {@link PostgresClusterSize}
   */
  clusterSize: PostgresClusterSize;

  /**
   * PostgreSQL major version. Defaults to the latest available major
   * version.
   */
  majorVersion?: string;

  /**
   * CPU architecture. Cannot be changed after creation.
   * @default "x86"
   */
  arch?: "x86" | "arm";
}

/**
 * Output attributes of a deployed PostgreSQL PlanetScale database.
 */
export interface PostgresDatabaseAttributes extends BaseDatabaseAttributes {
  /** PostgreSQL CPU architecture. */
  arch: "x86" | "arm";
}

/**
 * A PostgreSQL PlanetScale database. For MySQL, use {@link MySQLDatabase}
 * instead.
 *
 * ### Creating a PostgreSQL Database
 * **Example:** Basic PostgreSQL database
 * ```typescript
 * const db = yield* Planetscale.PostgresDatabase("MyDb", {
 *   clusterSize: "PS_10",
 * });
 * ```
 *
 * **Example:** PlanetScale Metal (NVMe)
 * ```typescript
 * const db = yield* Planetscale.PostgresDatabase("MyDb", {
 *   clusterSize: "M1_10_AWS_ARM_D_METAL_10",
 *   arch: "arm",
 * });
 * ```
 *
 * ### Migrations and seed data
 * **Example:** Apply migrations and seed files
 * ```typescript
 * const db = yield* Planetscale.PostgresDatabase("MyDb", {
 *   clusterSize: "PS_10",
 *   migrationsDir: "./migrations/postgres",
 *   importFiles: ["./seed/postgres.sql"],
 * });
 * ```
 *
 * ### Adoption
 * **Example:** Adopting an existing database
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * const db = yield* Planetscale.PostgresDatabase("Existing", {
 *   name: "existing-db",
 *   clusterSize: "PS_10",
 * }).pipe(adopt());
 * ```
 */
export type PostgresDatabase = Resource<
  "Planetscale.PostgresDatabase",
  PostgresDatabaseProps,
  PostgresDatabaseAttributes,
  never,
  Providers
>;

/** @resource */
export const PostgresDatabase = Resource<PostgresDatabase>(
  "Planetscale.PostgresDatabase",
);

export const PostgresDatabaseProvider = () =>
  Provider.succeed(PostgresDatabase, {
    stables: ["id", "organization", "region"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      // Database names are rename-mutable (reconcile folds `new_name`
      // into the settings sync), so `name` cannot live in the
      // provider-level stables. Almost no update is a rename though —
      // for those, advertise `name` as stable on the update so
      // downstream consumers (branches, roles) still resolve
      // `database.name` at plan time instead of seeing `undefined` and
      // falsely planning a replacement. The name only changes when the
      // `name` prop itself changes: an explicit name renames iff it
      // differs from the observed name, and an omitted name is
      // engine-generated deterministically (stable across updates).
      const nameIsStable =
        output?.name !== undefined &&
        (news.name !== undefined
          ? news.name === output.name
          : olds?.name === undefined);
      const stables = nameIsStable
        ? ["id", "organization", "region", "name"]
        : undefined;

      if (
        news.region?.slug &&
        output?.region?.slug &&
        news.region.slug !== output.region.slug
      ) {
        return { action: "replace" } as const;
      }

      if (news.replicas !== olds.replicas) {
        return { action: "replace" } as const;
      }

      const oldArch = output?.arch ?? olds.arch ?? "x86";
      if (news.arch && news.arch !== oldArch) {
        return { action: "replace" } as const;
      }

      if (yield* diffMigrations({ news, output })) {
        return { action: "update", stables } as const;
      }
      if (news.importFiles?.length) {
        const newHashes = yield* hashImports(news.importFiles, yield* rootDir);
        if (!recordsEqual(newHashes, output?.importHashes ?? {})) {
          return { action: "update", stables } as const;
        }
      }

      // Remaining prop changes (rename, settings, clusterSize, …) are
      // in-place updates. Decide them here instead of falling back to
      // the engine's default deep-compare so the conditional `name`
      // stable above is attached — the default path uses the
      // provider-level stables, which strip `name` from downstream plan
      // resolution.
      if (havePropsChanged(olds, news)) {
        return { action: "update", stables } as const;
      }

      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { organization } = yield* yield* Credentials;
      const databaseName =
        output?.name ?? (yield* createDatabaseName(id, olds?.name));

      const data = yield* planetscale
        .getDatabase({
          organization,
          database: databaseName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

      if (!data) return undefined;

      if (data.kind !== "postgresql") {
        return yield* Effect.fail(
          new PlanetscaleConflict({
            message:
              `Planetscale database "${data.name}" has kind "${data.kind}" but this resource ` +
              `is a PostgresDatabase. Use Planetscale.${data.kind === "mysql" ? "MySQLDatabase" : data.kind}() instead, ` +
              `or delete the existing database and retry.`,
          }),
        );
      }

      const defaultBranch = data.default_branch ?? "main";

      // Observe `arch` and `clusterSize` from the default branch rather
      // than echoing input.
      const branch = yield* planetscale
        .getBranch({
          organization,
          database: data.name,
          branch: defaultBranch,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

      const arch: "x86" | "arm" =
        branch!.cluster_architecture === "aarch64" ? "arm" : "x86";
      const clusterSize = branch!.cluster_name;

      return {
        id: data.id,
        name: data.name,
        organization,
        state: data.state,
        defaultBranch,
        plan: data.plan ?? "hobby",
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        htmlUrl: data.html_url,
        region: { slug: data.region.slug },
        migrationsDir:
          output?.migrationsDir ?? (olds && migrationsInputOf(olds))?.dir,
        migrationsTable:
          output?.migrationsTable ?? (olds && migrationsInputOf(olds))?.table,
        migrationsHashes: output?.migrationsHashes ?? {},
        importHashes: output?.importHashes ?? {},
        clusterSize,
        arch,
        requireApprovalForDeploy: data.require_approval_for_deploy ?? false,
        restrictBranchRegion: data.restrict_branch_region ?? false,
        productionBranchWebConsole: data.production_branch_web_console ?? false,
      };
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const { organization } = yield* yield* Credentials;
      const newName = yield* createDatabaseName(id, news.name);
      const clusterSize = toPostgresClusterSku({
        size: news.clusterSize,
        arch: news.arch,
        region: news.region?.slug,
      });

      // Observe — read live state under either the cached name (rename
      // / refresh) or the freshly-derived name (greenfield). Observing
      // unconditionally absorbs the race between `read` and `reconcile`
      // — if a foreign actor (or a previously-failed-to-persist
      // create) produced a database under the desired name in the
      // meantime, we'll find it here and skip the duplicate create.
      // Adoption routing has already been gated by `read` returning
      // `Unowned`, so by the time we reach reconcile any observed
      // database is fair game.
      const observedName = output?.name ?? newName;
      let observed = yield* planetscale
        .getDatabase({
          organization,
          database: observedName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

      // Ensure — if missing, create.
      if (!observed) {
        yield* session.note("Creating database...");
        observed = yield* planetscale.createDatabase({
          organization,
          name: newName,
          region: news.region?.slug,
          kind: "postgresql",
          cluster_size: clusterSize,
          replicas: news.replicas,
          major_version: news.majorVersion,
        });
      }

      // Wait for the database to finish provisioning before any
      // downstream sync runs. PlanetScale reports `state: "pending"`
      // for a while after createDatabase returns, during which branch
      // operations on this database (including our own settings PATCH)
      // race against the provisioning fiber.
      yield* waitForDatabaseReady(organization, observed.name, session);

      if (observed.kind !== "postgresql") {
        return yield* Effect.fail(
          new PlanetscaleConflict({
            message:
              `Planetscale database "${observed.name}" has kind "${observed.kind}" but this resource ` +
              `is a PostgresDatabase. Use Planetscale.${observed.kind === "mysql" ? "MySQLDatabase" : observed.kind}() instead, ` +
              `or delete the existing database and retry.`,
          }),
        );
      }

      // Sync — ensure a non-`main` default branch exists before
      // referencing it via `default_branch`. The branch is created
      // empty (no cluster size yet); we'll size it below.
      if (news.defaultBranch && news.defaultBranch !== "main") {
        yield* waitForDatabaseReady(organization, observed.name, session);
        const branchExists = yield* planetscale
          .getBranch({
            organization,
            database: observed.name,
            branch: news.defaultBranch,
          })
          .pipe(
            Effect.map(() => true),
            Effect.catchTag("NotFound", () => Effect.succeed(false)),
          );
        if (!branchExists) {
          yield* planetscale.createBranch({
            organization,
            database: observed.name,
            name: news.defaultBranch,
            parent_branch: "main",
          });
        }
      }

      // Sync settings — `updateSettings` is upsert-shaped, so we can
      // call it with the full desired payload on every reconcile.
      // Folds the rename in via `new_name` so we don't pay for a
      // separate PATCH.
      const updated = yield* planetscale.updateDatabaseSettings({
        organization,
        database: observed.name,
        new_name: newName !== observed.name ? newName : undefined,
        require_approval_for_deploy: news.requireApprovalForDeploy,
        restrict_branch_region: news.restrictBranchRegion,
        production_branch_web_console: news.productionBranchWebConsole,
        default_branch: news.defaultBranch,
      });

      // Sync cluster size on the active default branch.
      const branch = news.defaultBranch ?? updated.default_branch ?? "main";
      yield* ensurePostgresProductionBranchClusterSize(
        organization,
        updated.name,
        branch,
        news.clusterSize,
      );

      const migrationTarget = {
        organization,
        database: updated.name,
        branch,
      };
      const migrationsInput = migrationsInputOf(news);
      if (migrationsInput || news.importFiles?.length) {
        yield* waitForBranchReady(organization, updated.name, branch, session);
      }
      const migrations = migrationsInput
        ? yield* runPostgresMigrations(
            migrationTarget,
            migrationsInput,
            stampedOf(output),
          )
        : undefined;
      const importHashes = news.importFiles?.length
        ? yield* runPostgresImports(
            migrationTarget,
            news.importFiles,
            yield* rootDir,
            output?.importHashes ?? {},
          )
        : {};

      return {
        id: updated.id,
        name: updated.name,
        organization,
        state: updated.state,
        defaultBranch: updated.default_branch ?? branch,
        plan: updated.plan ?? output?.plan ?? "hobby",
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
        htmlUrl: updated.html_url,
        region: { slug: updated.region.slug },
        clusterSize: clusterSize,
        ...migrationsAttrs({ input: migrationsInput, run: migrations, output }),
        importHashes,
        arch: news.arch ?? output?.arch ?? "x86",
        requireApprovalForDeploy: updated.require_approval_for_deploy ?? false,
        restrictBranchRegion: updated.restrict_branch_region ?? false,
        productionBranchWebConsole:
          updated.production_branch_web_console ?? false,
      } satisfies PostgresDatabaseAttributes;
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* planetscale
        .deleteDatabase({
          organization: output.organization,
          database: output.name,
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
              page.data.filter((db) => db.kind === "postgresql"),
            ),
          ),
        );

      const rows = yield* Effect.forEach(
        databases,
        (data) =>
          Effect.gen(function* () {
            const defaultBranch = data.default_branch ?? "main";
            const branch = yield* planetscale
              .getBranch({
                organization,
                database: data.name,
                branch: defaultBranch,
              })
              .pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              );

            const arch: "x86" | "arm" =
              branch?.cluster_architecture === "aarch64" ? "arm" : "x86";
            const clusterSize = branch?.cluster_name ?? "";

            const attrs: PostgresDatabase["Attributes"] = {
              id: data.id,
              name: data.name,
              organization,
              state: data.state,
              defaultBranch,
              plan: data.plan ?? "hobby",
              createdAt: data.created_at,
              updatedAt: data.updated_at,
              htmlUrl: data.html_url,
              region: { slug: data.region.slug },
              clusterSize,
              migrationsDir: undefined,
              migrationsTable: undefined,
              migrationsHashes: {},
              importHashes: {},
              arch,
              requireApprovalForDeploy:
                data.require_approval_for_deploy ?? false,
              restrictBranchRegion: data.restrict_branch_region ?? false,
              productionBranchWebConsole:
                data.production_branch_web_console ?? false,
            };
            return attrs;
          }),
        { concurrency: 10 },
      );

      return rows;
    }),
  });

const createDatabaseName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return (
      name ??
      (yield* createPhysicalName({ id, lowercase: true, maxLength: 63 }))
    );
  });

const rootDir = Effect.sync(() => process.cwd());
