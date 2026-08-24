import { proxyChain } from "@/Util/proxy-chain.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

const TIMEOUT = 5_000;

/**
 * A fake drizzle-like db. `select()` and `echo()` are real methods that
 * read `this` — so replaying them with the wrong receiver would throw,
 * which is how we assert `this`-binding is preserved through the proxy.
 */
const makeDb = () => ({
  greeting: "hi",
  echo(n: number) {
    return Effect.succeed(`${this.greeting}:${n}`);
  },
  select() {
    const greeting = this.greeting;
    return {
      from: (table: string) => Effect.succeed([`${greeting}/${table}`]),
    };
  },
});

type Db = ReturnType<typeof makeDb>;

describe("proxyChain", () => {
  it.effect("replays a property-read + call chain when yielded", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.succeed(makeDb()));
      const rows = yield* db.select().from("users");
      expect(rows).toEqual(["hi/users"]);
    }),
  );

  it.effect("binds `this` to the receiver for method calls", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.succeed(makeDb()));
      // `echo` reads `this.greeting`; a dropped receiver would throw.
      const result = yield* db.echo(7);
      expect(result).toBe("hi:7");
    }),
  );

  it.effect(
    "is lazy — does not resolve the underlying effect until yielded",
    () =>
      Effect.gen(function* () {
        let built = 0;
        const db = proxyChain<Db>(
          Effect.sync(() => {
            built++;
            return makeDb();
          }),
        );

        // Building the op chain must not touch the underlying effect.
        const query = db.select().from("users");
        expect(built).toBe(0);

        yield* query;
        expect(built).toBe(1);
      }),
  );

  it.effect(
    "works as an Effect inside Effect.all (regression: used to hang)",
    () =>
      Effect.gen(function* () {
        const db = proxyChain<Db>(Effect.succeed(makeDb()));
        const results = yield* Effect.all([
          db.select().from("users"),
          db.select().from("posts"),
        ]);
        expect(results).toEqual([["hi/users"], ["hi/posts"]]);
      }),
  );

  it.effect("works inside Effect.forEach", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.succeed(makeDb()));
      const results = yield* Effect.forEach(
        ["users", "posts", "comments"],
        (table) => db.select().from(table),
      );
      expect(results).toEqual([["hi/users"], ["hi/posts"], ["hi/comments"]]);
    }),
  );

  it.effect(
    "supports `.pipe` on a chain (forwarded to the resolved effect)",
    () =>
      Effect.gen(function* () {
        const db = proxyChain<Db>(Effect.succeed(makeDb()));
        const rows = yield* db
          .select()
          .from("users")
          .pipe(Effect.map((rows) => rows.map((r) => r.toUpperCase())));
        expect(rows).toEqual(["HI/USERS"]);
      }),
  );

  it.effect("supports `.pipe` recovering a failure", () =>
    Effect.gen(function* () {
      const db = proxyChain<{ boom: () => Effect.Effect<string, string> }>(
        Effect.succeed({ boom: () => Effect.fail("nope") }),
      );
      const result = yield* db
        .boom()
        .pipe(Effect.catch((e) => Effect.succeed(`recovered:${e}`)));
      expect(result).toBe("recovered:nope");
    }),
  );

  it.effect("is recognized by predicate-dispatched Effect operators", () =>
    Effect.gen(function* () {
      const api = proxyChain(
        Effect.succeed({
          transaction: () => Effect.fail({ _tag: "TestError" } as const),
        }),
      );

      const transaction = api.transaction();

      expect(Effect.isEffect(transaction)).toBe(true);

      const result = yield* transaction.pipe(
        Effect.catchTag("TestError", () => Effect.succeed("recovered")),
      );

      expect(result).toBe("recovered");
    }),
  );

  it.effect("a `.pipe`-d chain still composes inside Effect.all", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.succeed(makeDb()));
      const results = yield* Effect.all([
        db
          .select()
          .from("users")
          .pipe(Effect.map((r) => r.length)),
        db
          .select()
          .from("posts")
          .pipe(Effect.map((r) => r.length)),
      ]);
      expect(results).toEqual([1, 1]);
    }),
  );

  it.effect("propagates failures from the resolved effect", () =>
    Effect.gen(function* () {
      const db = proxyChain<{ boom: () => Effect.Effect<never, string> }>(
        Effect.succeed({ boom: () => Effect.fail("nope") }),
      );
      const error = yield* Effect.flip(db.boom());
      expect(error).toBe("nope");
    }),
  );

  it.effect("propagates failures from the underlying (cached) effect", () =>
    Effect.gen(function* () {
      const db = proxyChain<Db>(Effect.fail("connect failed"));
      const error = yield* Effect.flip(db.select().from("users"));
      expect(error).toBe("connect failed");
    }),
  );

  /**
   * A fake `@effect/sql`-like client: a tagged-template function with
   * synchronous fragment helpers (`insert`, `and`) hanging off it — the shape
   * that surfaced the nested-proxy bug (`sql.insert(row)` inside an outer
   * `` sql`...` `` template was passed to the real client as a proxy, which
   * D1 then tried to bind as a parameter).
   */
  const makeSql = () => {
    const render = (v: unknown): string =>
      typeof v === "string" && v.startsWith("frag:")
        ? v.slice("frag:".length)
        : typeof v === "function"
          ? "?fn"
          : `?${JSON.stringify(v)}`;
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
      Effect.succeed(
        strings.reduce(
          (acc, s, i) => acc + s + (i < values.length ? render(values[i]) : ""),
          "",
        ),
      );
    sql.insert = (row: Record<string, unknown>) =>
      `frag:(${Object.keys(row).join(",")}) VALUES (${Object.values(row).join(",")})`;
    sql.and = (parts: unknown[]) => `frag:(${parts.map(render).join(" AND ")})`;
    return sql;
  };

  type Sql = ReturnType<typeof makeSql>;

  describe("nested chains as call arguments", () => {
    it.effect(
      "replays a nested chain argument against the same root (sql.insert)",
      () =>
        Effect.gen(function* () {
          const sql = proxyChain<Sql>(Effect.succeed(makeSql()));
          const query =
            yield* sql`INSERT INTO users ${sql.insert({ id: 1, name: "'alice'" })}`;
          expect(query).toBe("INSERT INTO users (id,name) VALUES (1,'alice')");
        }),
    );

    it.effect("replays nested chains inside array arguments (sql.and)", () =>
      Effect.gen(function* () {
        const sql = proxyChain<Sql>(Effect.succeed(makeSql()));
        const query = yield* sql`SELECT * FROM users WHERE ${sql.and([
          sql.insert({ a: 1 }),
          sql.insert({ b: 2 }),
        ])}`;
        expect(query).toBe(
          "SELECT * FROM users WHERE ((a) VALUES (1) AND (b) VALUES (2))",
        );
      }),
    );

    it.effect("leaves plain values and non-chain objects untouched", () =>
      Effect.gen(function* () {
        const sql = proxyChain<Sql>(Effect.succeed(makeSql()));
        const query = yield* sql`SELECT ${42} FROM ${{ obj: true }}`;
        expect(query).toBe('SELECT ?42 FROM ?{"obj":true}');
      }),
    );

    it.effect(
      "resolves the underlying effect exactly once for outer + nested chains",
      () =>
        Effect.gen(function* () {
          let built = 0;
          const sql = proxyChain<Sql>(
            Effect.sync(() => {
              built++;
              return makeSql();
            }),
          );
          const query = sql`INSERT INTO t ${sql.insert({ x: 9 })}`;
          // Building the composite chain must not resolve anything…
          expect(built).toBe(0);
          yield* query;
          // …and the nested chain reuses the outer chain's resolved root.
          expect(built).toBe(1);
        }),
    );

    it.effect(
      "leaves a chain over a *different* underlying effect untouched",
      () =>
        Effect.gen(function* () {
          const sqlA = proxyChain<Sql>(Effect.succeed(makeSql()));
          const other = proxyChain<Db>(Effect.succeed(makeDb()));
          // `other.select()` is a proxy over a different cached effect — it
          // can't be replayed synchronously, so it must pass through as-is
          // (rendered as an opaque bind value by the fake client).
          const query = yield* sqlA`SELECT ${other.select()}`;
          expect(query).toBe("SELECT ?fn");
        }),
    );
  });
}, 5000);
