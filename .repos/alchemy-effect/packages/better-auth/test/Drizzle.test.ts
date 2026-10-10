import { RuntimeContext } from "alchemy";
import { describe, expect, it } from "alchemy-test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { BetterAuth, Database } from "@/index.ts";
import { Drizzle } from "@/Drizzle.ts";
import * as schema from "./fixtures/drizzle-auth-schema.ts";

describe("BetterAuth (drizzle)", { tags: ["unit", "local"] }, () => {
  it.live(
    "uses generated Relations v2 for sign-up, sign-in, and joined sessions",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const migration = yield* fs.readFileString(
          yield* path.fromFileUrl(
            new URL("./fixtures/drizzle-auth.sql", import.meta.url),
          ),
        );
        const { drizzle } = yield* Effect.promise(
          () => import("drizzle-orm/bun-sqlite"),
        );
        const { Database: BunSqlite } = yield* Effect.promise(
          () => import("bun:sqlite"),
        );
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => new BunSqlite(":memory:")),
          (client) => Effect.sync(() => client.close()),
        );
        yield* Effect.sync(() => client.exec(migration));
        const db = yield* Effect.sync(() =>
          drizzle({ client, relations: schema.authRelations }),
        );
        const auth = yield* BetterAuth({
          baseURL: "http://localhost:3000",
          secret: "test-secret-test-secret-test-secret",
          emailAndPassword: { enabled: true },
          advanced: { database: { joins: true } },
        }).pipe(Effect.provide(Drizzle(db, { provider: "sqlite", schema })));
        const signUp = yield* auth.api.signUpEmail({
          body: {
            email: "drizzle@example.com",
            password: "password1234",
            name: "Drizzle User",
          },
        });
        const raw = yield* auth.auth;
        const response = yield* Effect.promise(() =>
          raw.api.signInEmail({
            body: { email: "drizzle@example.com", password: "password1234" },
            asResponse: true,
          }),
        );
        expect(response.status).toBe(200);
        const cookie = response.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        const session = yield* auth.getSession(new Headers({ cookie }));
        expect(session?.user.id).toBe(signUp.user.id);
        expect(session?.user.email).toBe("drizzle@example.com");
        expect(yield* auth.getSession(new Headers())).toBeNull();
      }).pipe(
        Effect.scoped,
        Effect.provide(BunServices.layer),
        Effect.provide(RuntimeContext.phantom),
      ),
  );

  it.live("accepts a request-scoped Postgres client", () =>
    Effect.gen(function* () {
      const { drizzle } = yield* Effect.promise(
        () => import("drizzle-orm/node-postgres"),
      );
      const { Pool } = yield* Effect.promise(() => import("pg"));
      let acquired = 0;
      let released = 0;
      const database = Effect.gen(function* () {
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => {
            acquired++;
            return new Pool();
          }),
          (pool) =>
            Effect.promise(() => pool.end()).pipe(
              Effect.tap(() => Effect.sync(() => released++)),
            ),
        );
        return yield* Effect.sync(() => drizzle({ client }));
      });
      const service = yield* Database.pipe(
        Effect.provide(Drizzle(database, { provider: "pg" })),
      );
      expect(acquired).toBe(0);
      expect(typeof (yield* service.runtime.pipe(Effect.scoped))).toBe(
        "function",
      );
      expect(acquired).toBe(1);
      expect(released).toBe(1);
    }).pipe(Effect.provide(RuntimeContext.phantom)),
  );

  it.live("wraps an existing drizzle db via the official adapter", () =>
    Effect.gen(function* () {
      const { drizzle } = yield* Effect.promise(
        () => import("drizzle-orm/bun-sqlite"),
      );
      const { Database: BunSqlite } = yield* Effect.promise(
        () => import("bun:sqlite"),
      );
      const db = drizzle({ client: new BunSqlite(":memory:") });

      const service = yield* Database.pipe(
        Effect.provide(
          Drizzle(db, {
            provider: "sqlite",
          }),
        ),
      );
      // "pg" | "mysql" | "sqlite" maps onto the Database provider kinds
      expect(service.provider).toBe("sqlite");
      // no automatic migration support — schema is user-owned
      expect(service.migrate).toBeUndefined();
      // the runtime input is better-auth's adapter factory
      const input = yield* Effect.scoped(service.runtime);
      expect(typeof input).toBe("function");
    }).pipe(Effect.provide(RuntimeContext.phantom)),
  );
});
