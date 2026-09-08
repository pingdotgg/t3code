import { RuntimeContext } from "alchemy";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { Database } from "@/index.ts";
import { Drizzle } from "@/Drizzle.ts";

describe("BetterAuth (drizzle)", () => {
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
          Drizzle(db as unknown as Record<string, unknown>, {
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
