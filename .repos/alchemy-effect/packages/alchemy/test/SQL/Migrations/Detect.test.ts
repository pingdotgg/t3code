import {
  detectLayout,
  inlineSqlParams,
  normalizeMigrationsInput,
  readDrizzleDirRecords,
  readFlatRecords,
  resolveMigrations,
  timestampPrefixMillis,
} from "@/SQL/Migrations/index.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe as plainDescribe, expect, layer, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const fixture = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url).pathname;

const describe = layer(NodeServices.layer);

describe("detectLayout", (it) => {
  it.effect("classifies drizzle-kit v1 dirs as directory layout", () =>
    Effect.gen(function* () {
      expect(yield* detectLayout(fixture("drizzle-v1"))).toBe("directory");
    }),
  );

  it.effect("classifies Prisma dirs as directory layout too", () =>
    // Prisma and drizzle-v1 share the `<ts>_<name>/migration.sql` shape;
    // both key records by directory name.
    Effect.gen(function* () {
      expect(yield* detectLayout(fixture("prisma"))).toBe("directory");
    }),
  );

  it.effect("classifies flat .sql directories", () =>
    Effect.gen(function* () {
      expect(yield* detectLayout(fixture("flat"))).toBe("flat");
    }),
  );

  it.effect("fails on drizzle-v0 layouts with the drizzle-kit up hint", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(detectLayout(fixture("drizzle-v0")));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("DrizzleV0LayoutError");
        expect(result.failure.message).toContain("drizzle-kit up");
      }
    }),
  );

  it.effect("treats a missing directory as flat", () =>
    Effect.gen(function* () {
      expect(yield* detectLayout(fixture("does-not-exist"))).toBe("flat");
    }),
  );
});

describe("readers", (it) => {
  it.effect("directory-layout records are keyed by directory name", () =>
    Effect.gen(function* () {
      const records = yield* readDrizzleDirRecords(fixture("drizzle-v1"));
      expect(records.map((r) => r.name)).toEqual([
        "20240101000000_init",
        "20240102000000_add_posts",
      ]);
      expect(records[0].createdAtMillis).toBe(Date.UTC(2024, 0, 1));
      // statement-breakpoint splitting
      expect(records[0].statements.length).toBe(2);
      expect(records[0].hash).toMatch(/^[0-9a-f]{64}$/);
    }),
  );

  it.effect("flat records are keyed by relative file path", () =>
    Effect.gen(function* () {
      const records = yield* readFlatRecords(fixture("flat"));
      expect(records.map((r) => r.name)).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);
    }),
  );
});

plainDescribe("resolveMigrations", () => {
  test("defaults to __alchemy_migrations", () => {
    expect(resolveMigrations({ input: { dir: "./m" }, stamped: {} })).toEqual({
      dir: "./m",
      table: "__alchemy_migrations",
    });
  });

  test("a table persisted by a prior deploy wins over the default", () => {
    // Pre-registry deploys persisted their table name (d1_migrations,
    // neon_migrations, custom names); honoring it keeps them converging
    // against the same table, upgraded in place.
    expect(
      resolveMigrations({
        input: { dir: "./m" },
        stamped: { table: "neon_migrations" },
      }).table,
    ).toBe("neon_migrations");
  });

  test("an explicit table always wins", () => {
    expect(
      resolveMigrations({
        input: { dir: "./m", table: "my_migrations" },
        stamped: { table: "d1_migrations" },
      }).table,
    ).toBe("my_migrations");
  });
});

plainDescribe("normalizeMigrationsInput", () => {
  test("string is a directory", () => {
    expect(normalizeMigrationsInput("./migrations")).toEqual({
      dir: "./migrations",
    });
  });
  test("Drizzle.Schema-shaped outputs are accepted structurally", () => {
    expect(normalizeMigrationsInput({ out: "./migrations" })).toEqual({
      dir: "./migrations",
    });
  });
  test("object form passes through", () => {
    expect(normalizeMigrationsInput({ dir: "./m", table: "t" })).toEqual({
      dir: "./m",
      table: "t",
    });
  });
});

plainDescribe("helpers", () => {
  test("timestampPrefixMillis parses drizzle dir prefixes", () => {
    expect(timestampPrefixMillis("20240101000000_init")).toBe(
      Date.UTC(2024, 0, 1),
    );
    expect(timestampPrefixMillis("0001_users.sql")).toBeUndefined();
  });

  test("inlineSqlParams inlines ? placeholders outside quotes", () => {
    expect(
      inlineSqlParams(
        "INSERT INTO t (a, b) VALUES (?, ?);",
        ["it's", 42],
        "sqlite",
      ),
    ).toBe("INSERT INTO t (a, b) VALUES ('it''s', 42);");
    expect(
      inlineSqlParams(
        "SELECT * FROM t WHERE a = 'lit?' AND b = ?;",
        [1],
        "sqlite",
      ),
    ).toBe("SELECT * FROM t WHERE a = 'lit?' AND b = 1;");
  });

  test("inlineSqlParams inlines $n placeholders for postgres", () => {
    expect(inlineSqlParams("SELECT $1, $2;", ["x", null], "postgres")).toBe(
      "SELECT 'x', NULL;",
    );
  });
});
