import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Artifacts from "../../Artifacts.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  type EmitResult,
  type MigrationPackage,
  type PlanResult,
  CliError,
  readMigrationPackages,
  rewriteEmittedTypes,
  resolveGraphHead,
  runPrismaCli,
} from "./internal.ts";

export type ContractProps = {
  /**
   * Path to the project's `prisma.config.ts`, relative to the current
   * working directory. The config is the single source of truth for the
   * contract source, emit output directory, and database defaults — exactly
   * as when running the `prisma` CLI by hand.
   *
   * @default "./prisma.config.ts"
   */
  config?: string;
  /**
   * Directory holding the migration graph (`app/` packages +
   * content-addressed `snapshots/`), relative to the **config file's
   * directory** — the same base the CLI resolves against. If you override
   * `orm.migrations.dir` in `prisma.config.ts`, set this to the same value.
   *
   * @default "./migrations"
   */
  migrationsDir?: string;
  /**
   * Name slug for migration directories planned during deploy
   * (`migrations/app/{timestamp}_{name}/`). Directory timestamps are
   * minute-resolution, so the default slug embeds the target contract hash
   * to keep rapid successive deploys from colliding.
   *
   * @default "migration-{contractHash prefix}"
   */
  name?: string;
};

export type Contract = Resource<
  "Prisma.Contract",
  ContractProps,
  {
    /**
     * The emitted contract's storage hash — the identity the migration graph
     * and the database marker track. Changes exactly when the contract's
     * storage shape changes; downstream {@link Migrate} resources diff this
     * against the database marker to decide whether to run.
     */
    contractHash: string;
    /**
     * Path to `prisma.config.ts`, relative to the current working
     * directory. Downstream resources ({@link Migrate}) inherit it so the
     * whole toolchain reads one config.
     */
    config: string;
    /** Path to the migration graph directory, relative to the current working directory. */
    migrationsDir: string;
    /** Migration package directory names in the app contract space, in name order. */
    migrations: string[];
    /** Path to the emitted `contract.json` (runtime IR), relative to the current working directory. */
    contractJson: string;
    /** Path to the emitted `contract.d.ts` (types), relative to the current working directory. */
    contractTypes: string;
  },
  never,
  Providers
>;

/**
 * A Prisma ORM v8 contract managed as an Alchemy resource.
 *
 * Runs `prisma contract emit` and — when the contract's storage shape
 * has drifted from the migration graph — `prisma migration plan` as
 * part of `alchemy deploy`, so the emitted contract artifacts
 * (`contract.json` / `contract.d.ts`) and the migration packages under
 * `migrations/` are always regenerated from the source contract before
 * anything downstream deploys. Pair it with {@link Migrate} to apply the
 * planned packages to a database in the same deploy:
 *
 * ```typescript
 * const contract = yield* Prisma.Contract("contract");
 *
 * const migrate = yield* Prisma.Migrate("migrate", {
 *   url: branch.origin.connectionString,
 *   contract,
 * });
 * ```
 *
 * Plans that require a human decision (data backfills rendered as
 * `placeholder(...)` closures in `migration.ts`) are never auto-answered:
 * the deploy fails with instructions to fill the placeholder, self-emit the
 * package (`node migrations/app/<dir>/migration.ts`), and commit — the next
 * deploy then sees no drift and applies the committed package.
 *
 * The resource is delete-safe: removing it from the stack does **not** wipe
 * the migrations directory or the emitted contract, since both are checked
 * in and shared with other environments.
 *
 * ### Declaring the contract
 * **Example:** Contract at the project root
 * ```typescript
 * // expects ./prisma.config.ts and writes ./migrations
 * const contract = yield* Prisma.Contract("contract");
 * ```
 *
 * **Example:** Custom config location
 * ```typescript
 * const contract = yield* Prisma.Contract("contract", {
 *   config: "./db/prisma.config.ts",
 *   // resolved relative to ./db (the config's directory)
 *   migrationsDir: "./migrations",
 * });
 * ```
 *
 * ### Applying migrations on deploy
 * **Example:** Contract + Migrate against Neon
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
 * @resource
 * @category ORM
 */
export const Contract = Resource<Contract>("Prisma.Contract");

const placeholderGuidance = (dir: string) =>
  [
    `The planned migration package ${dir} contains unfilled placeholder(s) — a data`,
    "backfill or destructive change that Prisma cannot decide automatically",
    "(the SQL is applied to a real database later in the same deploy).",
    "",
    "To resolve:",
    `  1. Edit ${dir}/migration.ts and replace each placeholder(...) with a typed query plan.`,
    `  2. Self-emit the package: node ${dir}/migration.ts`,
    "  3. Commit the package and re-deploy (the contract will see no drift and apply it).",
    "",
    `Or abandon the change: delete ${dir}/ and revert the contract source.`,
  ].join("\n");

export const ContractProvider = () =>
  Provider.effect(
    Contract,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Every prop is optional, so `Prisma.Contract("contract")` (no props
      // object at all) is legal — the engine then hands lifecycle ops
      // `undefined` rather than `{}`.
      const resolveConfig = (p: ContractProps | undefined) =>
        path.resolve(process.cwd(), p?.config ?? "./prisma.config.ts");

      const configDir = (p: ContractProps | undefined) =>
        path.dirname(resolveConfig(p));

      const resolveMigrationsDir = (p: ContractProps | undefined) =>
        path.resolve(configDir(p), p?.migrationsDir ?? "./migrations");

      // Attributes expose paths relative to the current working directory so
      // persisted state stays portable across machines/checkouts. Internal
      // filesystem ops always use the absolute forms.
      const relative = (abs: string) => path.relative(process.cwd(), abs);

      const emit = (p: ContractProps | undefined, outputPath?: string) =>
        runPrismaCli<EmitResult>(
          [
            "contract",
            "emit",
            "--config",
            resolveConfig(p),
            ...(outputPath ? ["--output-path", outputPath] : []),
          ],
          { cwd: configDir(p) },
        );

      /**
       * Emit the contract into a temp directory (so plan-time diffs never
       * mutate the workspace) and compare its storage hash against the
       * migration graph head. Cached per resource for the run so plan and
       * apply share one CLI invocation.
       */
      const detectDrift = (p: ContractProps | undefined) =>
        Effect.gen(function* () {
          const tmp = yield* fs.makeTempDirectory({
            prefix: "alchemy-prisma-contract-",
          });
          const emitted = yield* emit(p, tmp).pipe(
            Effect.ensuring(
              fs.remove(tmp, { recursive: true }).pipe(Effect.ignore),
            ),
          );
          const packages = yield* readMigrationPackages(
            resolveMigrationsDir(p),
          );
          const head = resolveGraphHead(packages);
          return {
            storageHash: emitted.storageHash,
            packages,
            head,
            // Drift when the graph doesn't cover the emitted contract, or the
            // head package was planned but never self-emitted (empty ops.json
            // means unfilled placeholders — reconcile re-raises the guidance).
            changed:
              head === undefined ||
              head.to !== emitted.storageHash ||
              head.opsEmpty,
          };
        }).pipe(Artifacts.cached("Prisma.Contract.detectDrift"));

      const attributes = (
        p: ContractProps | undefined,
        emitted: EmitResult,
        packages: readonly MigrationPackage[],
      ) => ({
        contractHash: emitted.storageHash,
        config: relative(resolveConfig(p)),
        migrationsDir: relative(resolveMigrationsDir(p)),
        migrations: packages.map((pkg) => pkg.dirName),
        contractJson: relative(emitted.files.json),
        contractTypes: relative(emitted.files.dts),
      });

      return {
        // Non-listable: a Prisma.Contract is a local build artifact (emitted
        // contract + migration packages under paths supplied entirely by
        // props). There is no remote store to enumerate.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          const drift = yield* detectDrift(news);
          // Emitted artifacts must exist on disk for the runtime bundle; a
          // fresh checkout without them needs a re-emit even with no drift.
          const emittedExists =
            output.contractJson !== undefined &&
            (yield* fs.exists(
              path.resolve(process.cwd(), output.contractJson),
            ));
          // Only flag an update when something would actually change —
          // otherwise downstream resources (e.g. Prisma.Migrate) would see
          // `contract.contractHash` as an unresolved Output during plan and
          // cascade into spurious updates of their own. The canonical-path
          // comparison migrates legacy state to cwd-relative form.
          return drift.changed ||
            !emittedExists ||
            output.config !== relative(resolveConfig(news)) ||
            output.migrationsDir !== relative(resolveMigrationsDir(news))
            ? { action: "update" }
            : undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (!output) return undefined;
          const props = olds ?? ({} as ContractProps);
          const migrationsDir = resolveMigrationsDir(props);
          const configExists = yield* fs.exists(resolveConfig(props));
          if (!configExists) return undefined;
          const packages = yield* readMigrationPackages(migrationsDir);
          const head = resolveGraphHead(packages);
          return {
            ...output,
            contractHash: head?.to ?? output.contractHash,
            migrationsDir: relative(migrationsDir),
            migrations: packages.map((pkg) => pkg.dirName),
          };
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          yield* session.note(
            `${output ? "Re-emitting" : "Emitting"} Prisma contract`,
          );
          const emitted = yield* emit(news);
          // Emits leak unpublished @internal/* specifiers (through rc.8);
          // rewrite them to the public @prisma/orm-* packages.
          yield* rewriteEmittedTypes(emitted.files.dts);
          const migrationsDir = resolveMigrationsDir(news);
          let packages = yield* readMigrationPackages(migrationsDir);
          const head = resolveGraphHead(packages);

          if (head === undefined || head.to !== emitted.storageHash) {
            yield* session.note(
              `Planning Prisma migration (${head ? `${head.to.slice(0, 8)} →` : "empty →"} ${emitted.storageHash.slice(0, 8)})`,
            );
            const plan = yield* runPrismaCli<PlanResult>(
              [
                "migration",
                "plan",
                "--config",
                resolveConfig(news),
                "--name",
                // Package directory names are minute-resolution
                // (`{YYYYMMDDTHHmm}_{name}`), so the default slug carries the
                // target hash to keep two plans in the same minute (e.g.
                // rapid successive deploys) from colliding.
                news?.name ?? `migration-${emitted.storageHash.slice(0, 8)}`,
                ...(head ? ["--from", head.to] : []),
              ],
              { cwd: configDir(news) },
            );
            if (plan.pendingPlaceholders) {
              const dir = plan.dir
                ? relative(path.resolve(configDir(news), plan.dir))
                : "the planned migration directory";
              return yield* Effect.fail(
                new CliError({ message: placeholderGuidance(dir) }),
              );
            }
            if (!plan.noOp && plan.dir !== undefined) {
              // Guard against a config/props mismatch: if the CLI wrote the
              // package outside the directory this resource watches, every
              // deploy would re-plan a duplicate package.
              const planDir = path.resolve(configDir(news), plan.dir);
              if (!planDir.startsWith(migrationsDir + path.sep)) {
                return yield* Effect.fail(
                  new CliError({
                    message: [
                      `prisma wrote the migration package to ${relative(planDir)},`,
                      `outside this resource's migrationsDir (${relative(migrationsDir)}).`,
                      "Set the `migrationsDir` prop to match `orm.migrations.dir` in prisma.config.ts.",
                    ].join("\n"),
                  }),
                );
              }
            }
            packages = yield* readMigrationPackages(migrationsDir);
          }

          // A converged graph whose head was planned earlier but never
          // self-emitted still blocks the deploy — Migrate would fail on it.
          const finalHead = resolveGraphHead(packages);
          if (finalHead?.opsEmpty) {
            const dir = relative(
              path.join(migrationsDir, "app", finalHead.dirName),
            );
            return yield* Effect.fail(
              new CliError({ message: placeholderGuidance(dir) }),
            );
          }

          return attributes(news, emitted, packages);
        }),
        delete: Effect.fn(function* () {
          // Emitted contract artifacts and migration packages are checked in;
          // do not delete on resource teardown.
        }),
      };
    }),
  );
