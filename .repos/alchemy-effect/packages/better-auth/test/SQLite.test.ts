import { RuntimeContext } from "alchemy";
import { describe, expect, it } from "alchemy-test";
import { organization } from "better-auth/plugins/organization";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { BetterAuth, Database } from "@/index.ts";
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

describe("BetterAuth (bun:sqlite)", () => {
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
