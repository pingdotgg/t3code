import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import path from "pathe";
import type { Database as BunDatabase } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { Database } from "./Database.ts";
import { BetterAuthMigrationError } from "./Errors.ts";

const open = (path: string): Effect.Effect<BunDatabase, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const { Database: BunSqlite } = await import("bun:sqlite");
      return new BunSqlite(path, { create: true });
    }),
    (db) => Effect.sync(() => db.close()),
  );

/**
 * Local `bun:sqlite` database layer for Better Auth — development and
 * tests on the bun runtime only (a deployed Worker/Lambda cannot open a
 * local SQLite file).
 *
 * Data persists in the file across runs; migrations run against the same
 * file at deploy time.
 *
 *
 * ### Local development
 * **Example:** File-backed auth for `alchemy dev`
 * ```typescript
 * import { BetterAuth } from "@alchemy.run/better-auth";
 * import { SQLite } from "@alchemy.run/better-auth/SQLite";
 *
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({ emailAndPassword: { enabled: true } });
 *   // ...
 * }).pipe(Effect.provide(SQLite(".alchemy/auth.sqlite")))
 * ```
 *
 * @param filename SQLite file path (parent directory must exist). Defaults to
 * `better-auth.sqlite` under the resolved `AlchemyContext.dotAlchemy` directory.
 * @default ".alchemy/better-auth.sqlite"
 *
 * @layer
 * @provides BetterAuth.Database
 * @product SQLite
 */
export const SQLite = (filename?: string): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const resolved =
        filename ?? path.join(yield* dotAlchemyDirectory, "better-auth.sqlite");
      return {
        provider: "sqlite",
        runtime: open(resolved),
        migrate: {
          identity: { path: resolved },
          connect: Effect.succeed(
            open(resolved).pipe(
              Effect.catchDefect((cause: unknown) =>
                Effect.fail(
                  new BetterAuthMigrationError({
                    message: `Failed to open SQLite database at ${resolved}`,
                    cause,
                  }),
                ),
              ),
            ),
          ),
        },
      };
    }),
  );
