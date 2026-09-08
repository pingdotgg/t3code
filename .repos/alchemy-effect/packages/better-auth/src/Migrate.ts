import { Action, Stack, type Output } from "alchemy";
import { sha256Object } from "alchemy/Util/sha256";
import { CurrentRuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import type { BetterAuthOptions } from "better-auth";
import { getSchema } from "better-auth/db";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { DatabaseService } from "./Database.ts";
import { BetterAuthMigrationError } from "./Errors.ts";

/**
 * Deploy-time migration machinery.
 *
 * This module is ONLY imported dynamically from inside
 * `if (!globalThis.__ALCHEMY_RUNTIME__)` in `BetterAuth.ts`, so none of it
 * (including `better-auth/db` and the Kysely-based migration engine pulled
 * in by `better-auth/db/migration`) ever reaches a deployed runtime bundle.
 *
 * @internal
 */

interface MigrateInput {
  /** Non-secret identity of the target database (from the platform layer). */
  identity: Record<string, unknown>;
  /** Fingerprint of the Better Auth schema (tables + fields). */
  schema: string;
  /** Dialect family — part of the input so a dialect swap re-runs. */
  provider: string;
}

export interface MigrateOutput {
  tablesCreated: number;
  tablesAltered: number;
}

export interface RegisterMigrationOptions {
  readonly id: string;
  /** The user's Better Auth options (without `database`). */
  readonly options: BetterAuthOptions;
  readonly db: DatabaseService;
  /** The user's `migrate` prop — `undefined` means default-on. */
  readonly migrate: boolean | undefined;
}

/**
 * Register the schema-migration Action for a `BetterAuth` instance.
 *
 * Actions run only during `alchemy deploy` (apply), re-run only when their
 * resolved input changes — here: the schema fingerprint, the database
 * identity, or the dialect — and their body gets the ambient stack
 * services, so `migrate.connect` can resolve resource Outputs and reach
 * the cloud.
 */
export const registerMigration = ({
  id,
  options,
  db,
  migrate,
}: RegisterMigrationOptions): Effect.Effect<void> =>
  Effect.gen(function* () {
    const support = db.migrate;
    if (support === undefined) {
      if (migrate === true) {
        return yield* Effect.die(
          new Error(
            `BetterAuth(${id}): \`migrate: true\` was requested, but the ` +
              `"${db.provider}" Database layer does not support automatic ` +
              "migrations. Remove `migrate: true` (and manage the schema " +
              "yourself, e.g. via `npx @better-auth/cli generate`) or use a " +
              "layer with migration support.",
          ),
        );
      }
      return;
    }
    if (migrate === false) {
      return;
    }
    // Outside a stack evaluation (unit tests driving BetterAuth directly)
    // there is nothing to register on — skip silently.
    const stack = yield* Effect.serviceOption(Stack);
    if (Option.isNone(stack)) {
      return;
    }

    // Init-effect form: `support.connect`'s outer half runs here under the
    // Action's capture context, so resource Outputs it yields (databaseId,
    // connection-string attrs) become dependency captures resolved at
    // apply. The returned runner does the actual connect + migrate.
    const Migrate = Action(
      "BetterAuth.Migrate",
      Effect.gen(function* () {
        const acquire = yield* support.connect;
        return (_input: MigrateInput) => runMigrationWith(acquire, options);
      }),
    );
    const result = yield* Migrate(`${id}Migrate`, {
      identity: support.identity,
      schema: yield* schemaFingerprint(options),
      provider: db.provider,
    }).pipe(
      // The Action call's requirements (Stack, the runner's Req) are
      // ambient during stack evaluation — erase them; presence of Stack
      // was checked above.
      (effect) => effect as unknown as Effect.Effect<Output<MigrateOutput>>,
    );

    // Bind the migration result into the host environment (when there is a
    // host): the host's env then depends on the Action's output, giving the
    // engine a Worker/Function → Migration dependency edge so first-deploy
    // traffic cannot race the schema.
    const rc = yield* CurrentRuntimeContext;
    if (rc !== undefined) {
      yield* rc.set(sanitizeKey(`${id}Migration`), result as never);
    }
  }) as Effect.Effect<void>;

/**
 * Connect via the platform layer's `migrate.connect` and apply Better
 * Auth's schema migrations. Additive and idempotent — re-running against
 * an up-to-date database is a no-op.
 */
export const applyMigrations = (
  support: NonNullable<DatabaseService["migrate"]>,
  options: BetterAuthOptions,
) =>
  Effect.flatMap(support.connect, (acquire) =>
    runMigrationWith(acquire, options),
  );

const runMigrationWith = (
  acquire: Effect.Effect<
    import("./Database.ts").DirectDatabase,
    BetterAuthMigrationError,
    import("effect/Scope").Scope
  >,
  options: BetterAuthOptions,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* acquire;
      if (typeof database === "function") {
        return yield* Effect.die(
          new Error(
            "BetterAuth migration: `connect` yielded an adapter factory — " +
              "migrations require a direct (Kysely-resolvable) database.",
          ),
        );
      }
      const { getMigrations } = yield* Effect.promise(
        () => import("better-auth/db/migration"),
      );
      const migrations = yield* Effect.tryPromise({
        try: () =>
          getMigrations({
            ...options,
            database,
            // getMigrations only introspects the schema; the secret is
            // irrelevant but required by the options type.
            secret: "alchemy-migrate",
            telemetry: { enabled: false },
          }),
        catch: (cause) =>
          new BetterAuthMigrationError({
            message: "Failed to compute Better Auth schema migrations",
            cause,
          }),
      });
      yield* Effect.tryPromise({
        try: () => migrations.runMigrations(),
        catch: (cause) =>
          new BetterAuthMigrationError({
            message: "Failed to apply Better Auth schema migrations",
            cause,
          }),
      });
      return {
        tablesCreated: migrations.toBeCreated.length,
        tablesAltered: migrations.toBeAdded.length,
      } satisfies MigrateOutput;
    }),
  );

/**
 * Stable fingerprint of the Better Auth schema derived from the user's
 * options (plugins, additionalFields, model renames). Changing the schema
 * changes the fingerprint, which changes the migration Action's input and
 * re-runs it on the next deploy.
 */
export const schemaFingerprint = (
  options: BetterAuthOptions,
): Effect.Effect<string> =>
  Effect.suspend(() => {
    const schema = getSchema(options);
    // Reduce to the migration-relevant field attributes; sha256Object's
    // stable serialization handles key ordering.
    const reduced = Object.fromEntries(
      Object.entries(schema).map(([table, def]) => [
        table,
        Object.fromEntries(
          Object.entries(def.fields).map(([name, field]) => [
            name,
            {
              type: String(field.type),
              required: field.required ?? false,
              unique: field.unique ?? false,
              references: field.references
                ? {
                    model: field.references.model,
                    field: field.references.field,
                  }
                : undefined,
            },
          ]),
        ),
      ]),
    );
    return sha256Object(reduced);
  });
