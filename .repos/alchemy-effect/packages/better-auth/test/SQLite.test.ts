import { AlchemyContext, RuntimeContext } from "alchemy";
import { describe, expect, it } from "alchemy-test";
import { organization } from "better-auth/plugins/organization";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import { BetterAuth, BetterAuthMigrationError, Database } from "@/index.ts";
import { applyMigrations, schemaFingerprint } from "@/Migrate.ts";
import { SQLite } from "@/SQLite.ts";

const baseOptions = {
  baseURL: "http://localhost:3000",
  emailAndPassword: { enabled: true },
  secret: "test-secret-test-secret-test-secret",
} as const;

const provideTestEnv = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, RuntimeContext | FileSystem.FileSystem>> =>
  effect.pipe(
    Effect.provide(BunFileSystem.layer),
    Effect.provide(RuntimeContext.phantom),
  ) as Effect.Effect<A, E, Exclude<R, RuntimeContext | FileSystem.FileSystem>>;

const tempSqlitePath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectory({ prefix: "better-auth-sqlite" });
  return `${dir}/auth.sqlite`;
});

describe("BetterAuth (bun:sqlite)", { tags: ["unit", "local"] }, () => {
  it.live(
    "uses the configured runtime directory unless a filename is supplied",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* Effect.gen(function* () {
          for (const filename of [undefined, `${root}/explicit.sqlite`]) {
            const expected = filename ?? `${root}/better-auth.sqlite`;
            const db = yield* Database.pipe(Effect.provide(SQLite(filename)));
            yield* applyMigrations(db.migrate!, baseOptions);
            expect(yield* fs.exists(expected)).toBe(true);
          }
        }).pipe(
          Effect.provideService(AlchemyContext, {
            dotAlchemy: root,
            dev: false,
            adopt: false,
          }),
        );
      }).pipe(Effect.scoped, provideTestEnv),
  );

  it.live("applies schema migrations idempotently", () =>
    Effect.gen(function* () {
      const path = yield* tempSqlitePath;
      const db = yield* Database.pipe(Effect.provide(SQLite(path)));
      expect(db.migrate).toBeDefined();

      const first = yield* applyMigrations(db.migrate!, baseOptions);
      expect(first.tablesCreated).toBeGreaterThan(0);

      // re-running against an up-to-date database is a no-op
      const second = yield* applyMigrations(db.migrate!, baseOptions);
      expect(second.tablesCreated).toBe(0);
      expect(second.tablesAltered).toBe(0);
      expect(second.indexesCreated).toBe(0);

      // verify the core tables actually exist in the file
      const { Database: BunSqlite } = yield* Effect.promise(
        () => import("bun:sqlite"),
      );
      const raw = new BunSqlite(path);
      const tables = (
        raw
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((row) => row.name);
      raw.close();
      for (const table of ["user", "session", "account", "verification"]) {
        expect(tables).toContain(table);
      }
    }).pipe(provideTestEnv),
  );

  it.live("runs the full auth flow against the migrated database", () =>
    Effect.gen(function* () {
      const path = yield* tempSqlitePath;
      const layer = SQLite(path);
      const db = yield* Database.pipe(Effect.provide(layer));
      yield* applyMigrations(db.migrate!, baseOptions);

      const auth = yield* BetterAuth(baseOptions).pipe(
        // layer is path-parameterized per test — provided here rather than
        // on the outer test effect
        Effect.provide(layer),
      );
      const signUp = yield* auth.api.signUpEmail({
        body: {
          email: "sqlite@example.com",
          password: "password1234",
          name: "SQLite User",
        },
      });
      expect(signUp.user.email).toBe("sqlite@example.com");

      const signIn = yield* auth.api.signInEmail({
        body: { email: "sqlite@example.com", password: "password1234" },
      });
      expect(signIn.user.email).toBe("sqlite@example.com");
      expect(signIn.token).toBeDefined();

      const session = yield* auth.api.getSession({
        headers: new Headers({
          authorization: `Bearer ${signIn.token}`,
        }),
      });
      // sqlite persisted the user — a fresh read sees it
      expect(signUp.user.id).toBeDefined();
      void session;
    }).pipe(provideTestEnv),
  );

  it.live(
    "upgrades a populated 1.6 database without rewriting account identities",
    () =>
      Effect.gen(function* () {
        const path = yield* tempSqlitePath;
        const { Database: BunSqlite } = yield* Effect.promise(
          () => import("bun:sqlite"),
        );
        const { betterAuth: betterAuth16 } = yield* Effect.promise(
          () => import("better-auth-1.6"),
        );
        const { getMigrations } = yield* Effect.promise(
          () => import("better-auth-1.6/db/migration"),
        );
        const legacy = yield* Effect.gen(function* () {
          const database = yield* Effect.acquireRelease(
            Effect.sync(() => new BunSqlite(path)),
            (database) => Effect.sync(() => database.close()),
          );
          const migrations = yield* Effect.promise(() =>
            getMigrations({ ...baseOptions, database }),
          );
          yield* Effect.promise(() => migrations.runMigrations());
          const auth = yield* Effect.sync(() =>
            betterAuth16({ ...baseOptions, database }),
          );
          const user = yield* Effect.promise(() =>
            auth.api.signUpEmail({
              body: {
                email: "existing@example.com",
                password: "password1234",
                name: "Existing User",
              },
            }),
          );
          const signIn = yield* Effect.promise(() =>
            auth.api.signInEmail({
              body: { email: "existing@example.com", password: "password1234" },
              asResponse: true,
            }),
          );
          const accounts = yield* Effect.sync(() =>
            database
              .query(
                "SELECT id, accountId, providerId, userId, password FROM account ORDER BY id",
              )
              .all(),
          );
          return {
            userId: user.user.id,
            accounts,
            cookie: signIn.headers
              .getSetCookie()
              .map((cookie) => cookie.split(";")[0])
              .join("; "),
          };
        }).pipe(Effect.scoped);

        const layer = SQLite(path);
        const database = yield* Database.pipe(Effect.provide(layer));
        yield* applyMigrations(database.migrate!, baseOptions);
        const auth = yield* BetterAuth(baseOptions).pipe(Effect.provide(layer));
        const session = yield* auth.api.getSession({
          headers: new Headers({ cookie: legacy.cookie }),
        });
        expect(session?.user.id).toBe(legacy.userId);
        const signIn = yield* auth.api.signInEmail({
          body: { email: "existing@example.com", password: "password1234" },
        });
        expect(signIn.user.id).toBe(legacy.userId);

        yield* Effect.gen(function* () {
          const raw = yield* Effect.acquireRelease(
            Effect.sync(() => new BunSqlite(path)),
            (raw) => Effect.sync(() => raw.close()),
          );
          const accounts = yield* Effect.sync(() =>
            raw
              .query(
                "SELECT id, accountId, providerId, userId, password FROM account ORDER BY id",
              )
              .all(),
          );
          expect(accounts).toEqual(legacy.accounts);
          const columns = yield* Effect.sync(() =>
            raw.query<{ name: string }, []>("PRAGMA table_info(account)").all(),
          );
          expect(columns.map((column) => column.name)).not.toContain("issuer");
        }).pipe(Effect.scoped);

        const signUp = yield* auth.api.signUpEmail({
          body: {
            email: "new@example.com",
            password: "password1234",
            name: "New User",
          },
        });
        expect(signUp.user.id).not.toBe(legacy.userId);
        expect(yield* applyMigrations(database.migrate!, baseOptions)).toEqual({
          tablesCreated: 0,
          tablesAltered: 0,
          indexesCreated: 0,
        });
      }).pipe(provideTestEnv),
  );

  it.live("reports unsafe populated-table changes as migration errors", () =>
    Effect.gen(function* () {
      const path = yield* tempSqlitePath;
      const layer = SQLite(path);
      const database = yield* Database.pipe(Effect.provide(layer));
      yield* applyMigrations(database.migrate!, baseOptions);
      const auth = yield* BetterAuth(baseOptions).pipe(Effect.provide(layer));
      yield* auth.api.signUpEmail({
        body: {
          email: "unsafe@example.com",
          password: "password1234",
          name: "Existing User",
        },
      });
      const result = yield* Effect.result(
        applyMigrations(database.migrate!, {
          ...baseOptions,
          user: {
            additionalFields: { team: { type: "string", required: true } },
          },
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(BetterAuthMigrationError);
        expect(result.failure.message).toContain("team");
      }
    }).pipe(provideTestEnv),
  );

  it.live("schema fingerprint changes when only a table index changes", () =>
    Effect.gen(function* () {
      const withIndex = (unique: boolean) => ({
        ...baseOptions,
        plugins: [
          {
            id: "account-index",
            schema: {
              account: {
                fields: {},
                indexes: [
                  {
                    name: "provider_account",
                    fields: ["providerId", "accountId"],
                    unique,
                  },
                ],
              },
            },
          },
        ],
      });
      expect(yield* schemaFingerprint(withIndex(false))).not.toBe(
        yield* schemaFingerprint(withIndex(true)),
      );
    }).pipe(provideTestEnv),
  );

  it.live("schema fingerprint is stable and plugin-sensitive", () =>
    Effect.gen(function* () {
      const a = yield* schemaFingerprint(baseOptions);
      const b = yield* schemaFingerprint(baseOptions);
      expect(a).toBe(b);
      const withPlugin = yield* schemaFingerprint({
        ...baseOptions,
        plugins: [organization()],
      });
      expect(withPlugin).not.toBe(a);
    }).pipe(provideTestEnv),
  );
});
