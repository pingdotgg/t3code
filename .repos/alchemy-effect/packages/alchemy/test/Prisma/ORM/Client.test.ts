import * as Neon from "@/Neon";
import * as Prisma from "@/Prisma";
import * as PrismaPostgres from "@/Prisma/ORM/Postgres.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { contract } from "./fixtures/client/contract.ts";
import { makeDatabase } from "./fixtures/psl/generated/client.ts";
import { makeDatabase as makeVariantDatabase } from "./fixtures/variants/generated/client.ts";
import { schemas } from "./fixtures/psl/generated/schemas.ts";
import * as Schema from "effect/Schema";

const { test } = Test.make({
  providers: Layer.mergeAll(Prisma.providers(), Neon.providers()),
});

const HOOK_TIMEOUT = 120_000;

test.provider(
  "PSL-generated client: CRUD, relations, schemas, and rollback",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const path = yield* Path.Path;
      const config = yield* path.fromFileUrl(
        new URL("./fixtures/psl/prisma.config.ts", import.meta.url),
      );
      const { branch } = yield* stack.deploy(
        Effect.gen(function* () {
          const contract = yield* Prisma.Contract("psl-contract", { config });
          const project = yield* Neon.Project("PrismaPslProject");
          const branch = yield* Neon.Branch("PrismaPslBranch", { project });
          yield* Prisma.Migrate("psl-migrate", {
            contract,
            url: branch.connectionUri,
          });
          return { branch };
        }),
      );
      const db = yield* makeDatabase(
        Effect.succeed(Redacted.make(branch.connectionUri)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const user = yield* db.orm.public.User.create({
            email: "psl@example.com",
            name: null,
          });
          const validated = yield* Schema.decodeUnknownEffect(
            schemas.public.User,
          )(user);
          expect(validated.id).toBe(user.id);
          yield* db.orm.public.Post.create({
            title: "PSL post",
            authorId: user.id,
          });
          const loaded = yield* db.orm.public.User.where({ id: user.id })
            .include("posts")
            .first();
          expect(loaded?.posts.map((post) => post.title)).toEqual(["PSL post"]);
          const rollback = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.orm.public.User.where({ id: user.id }).update({
                  name: "rolled back",
                });
                return yield* tx.rollback();
              }),
            )
            .pipe(Effect.result);
          expect(Result.isFailure(rollback)).toBe(true);
          expect(
            (yield* db.orm.public.User.where({ id: user.id }).first())?.name,
          ).toBeNull();
          yield* db.orm.public.Post.where({ authorId: user.id }).delete();
          yield* db.orm.public.User.where({ id: user.id }).delete();
          expect(yield* db.orm.public.User.all()).toEqual([]);
        }),
      );
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:project",
      "provider:prisma",
      "provider:prisma:orm",
      "live",
    ],
    timeout: HOOK_TIMEOUT,
  },
);

test.provider(
  "polymorphic collections: single-table and multi-table variants",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const path = yield* Path.Path;
      const config = yield* path.fromFileUrl(
        new URL("./fixtures/variants/prisma.config.ts", import.meta.url),
      );
      const { branch } = yield* stack.deploy(
        Effect.gen(function* () {
          const contract = yield* Prisma.Contract("variant-contract", {
            config,
          });
          const project = yield* Neon.Project("PrismaVariantProject");
          const branch = yield* Neon.Branch("PrismaVariantBranch", { project });
          yield* Prisma.Migrate("variant-migrate", {
            contract,
            url: branch.connectionUri,
          });
          return { branch };
        }),
      );
      const db = yield* makeVariantDatabase(
        Effect.succeed(Redacted.make(branch.connectionUri)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const assignee = yield* db.orm.public.Assignee.create({
            name: "Sam",
          });
          const bug = yield* db.orm.public.Task.variant("Bug").create({
            title: "Crash",
            severity: "critical",
            assigneeId: assignee.id,
          });
          const feature = yield* db.orm.public.Task.variant("Feature").create({
            title: "Search",
            priority: 3,
          });
          expect(bug).toMatchObject({ type: "bug", severity: "critical" });
          expect(feature).toMatchObject({ type: "feature", priority: 3 });
          const all = yield* db.orm.public.Task.orderBy((task) =>
            task.id.asc(),
          ).all();
          expect(all.map((task) => task.type)).toEqual(["bug", "feature"]);
          const narrowed = yield* db.orm.public.Task.variant("Feature")
            .where((task) => task.priority.gte(3))
            .orderBy((task) => task.priority.desc())
            .first();
          expect(narrowed).toMatchObject({ id: feature.id, priority: 3 });
          const included = yield* db.orm.public.Task.variant("Bug")
            .include("assignee")
            .first();
          expect(included?.assignee).toEqual(assignee);
          const selected = yield* db.orm.public.Task.variant("Bug")
            .include("assignee", (person) => person.select("name"))
            .select("id", "title")
            .first();
          expect(selected).toEqual({
            id: bug.id,
            title: "Crash",
            assignee: { name: "Sam" },
          });
          const rolledBack = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.orm.public.Task.variant("Feature").create({
                  title: "Undo",
                  priority: 5,
                });
                return yield* tx.rollback();
              }),
            )
            .pipe(Effect.result);
          expect(Result.isFailure(rolledBack)).toBe(true);
          expect(
            yield* db.orm.public.Task.variant("Feature").all(),
          ).toHaveLength(1);
          expect(
            yield* db.orm.public.Task.variant("Feature").deleteAndCount(),
          ).toBe(1);
          expect(
            yield* db.orm.public.Task.variant("Bug").deleteAndCount(),
          ).toBe(1);
          expect(yield* db.orm.public.Task.all()).toEqual([]);
        }),
      );
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:project",
      "provider:prisma",
      "provider:prisma:orm",
      "live",
    ],
    timeout: HOOK_TIMEOUT,
  },
);

const fixtureConfig = Effect.gen(function* () {
  const path = yield* Path.Path;
  const self = yield* path.fromFileUrl(new URL(import.meta.url));
  return path.join(
    path.dirname(self),
    "fixtures",
    "client",
    "prisma.config.ts",
  );
});

/** Deploy the fixture contract onto a fresh Neon branch and hand back a db. */
const deployDatabase = (stack: {
  deploy: <A, E, R>(e: Effect.Effect<A, E, R>) => any;
}) =>
  Effect.gen(function* () {
    const configPath = yield* fixtureConfig;
    const { branch } = yield* stack.deploy(
      Effect.gen(function* () {
        const contract = yield* Prisma.Contract("client-contract", {
          config: configPath,
        });
        const project = yield* Neon.Project("PrismaClientProject");
        const branch = yield* Neon.Branch("PrismaClientBranch", { project });
        yield* Prisma.Migrate("client-migrate", {
          url: branch.connectionUri,
          contract,
        });
        return { branch };
      }),
    );
    return yield* PrismaPostgres.Postgres(
      Effect.succeed(Redacted.make(branch.connectionUri as string)),
      { contract },
    );
  });

test.provider(
  "orm lane: typed CRUD, include, select, and where gating",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const db = yield* deployDatabase(stack);

      yield* Effect.scoped(
        Effect.gen(function* () {
          // create — input + row are contract-typed
          const alice = yield* db.orm.public.User.create({
            email: "alice@example.com",
            name: "Alice",
          });
          expect(alice.id).toBeGreaterThan(0);
          expect(alice.name).toEqual("Alice");

          yield* db.orm.public.Post.create({
            title: "hello",
            authorId: alice.id,
          });

          // include — Row gains a typed relation field
          const withPosts = yield* db.orm.public.User.where({ id: alice.id })
            .include("posts")
            .first();
          expect(withPosts?.posts).toHaveLength(1);
          expect(withPosts?.posts[0]?.title).toEqual("hello");

          // Shorthand filters keep their model field and value types.
          // @ts-expect-error unknown fields are not valid filters
          db.orm.public.User.where({ missing: "value" });
          // @ts-expect-error User.id is a number
          db.orm.public.User.where({ id: "not-a-number" });

          const bulk = yield* db.orm.public.Post.createAll([
            { title: "bulk-one", authorId: alice.id },
            { title: "bulk-two", authorId: alice.id },
          ]);
          expect(bulk.map((post) => post.title)).toEqual([
            "bulk-one",
            "bulk-two",
          ]);
          const count = yield* db.orm.public.Post.createAndCount([
            { title: "bulk-count", authorId: alice.id },
          ]);
          expect(count).toBe(1);
          const upserted = yield* db.orm.public.User.upsert({
            create: { email: "alice@example.com", name: "Alice" },
            update: { name: "Alice" },
            conflictOn: { email: "alice@example.com" },
          });
          expect(upserted.id).toBe(alice.id);

          db.orm.public.User.createAll([
            // @ts-expect-error bulk creates accept scalar fields only
            { email: "bulk@example.com", posts: () => undefined },
          ]);
          db.orm.public.User.createAndCount([
            // @ts-expect-error bulk creates accept scalar fields only
            { email: "bulk@example.com", posts: () => undefined },
          ]);
          db.orm.public.User.upsert({
            // @ts-expect-error upsert creates accept scalar fields only
            create: { email: "bulk@example.com", posts: () => undefined },
            update: {},
          });

          // where callback form
          const byEmail = yield* db.orm.public.User.where((u) =>
            u.email.eq("alice@example.com"),
          ).first();
          expect(byEmail?.id).toEqual(alice.id);

          // select — Row narrows to the projection
          const projected = yield* db.orm.public.User.select(
            "id",
            "email",
          ).all();
          expect(projected[0]?.email).toEqual("alice@example.com");
          // @ts-expect-error `name` was not selected — narrowing is real
          projected[0]?.name;

          // update requires a prior where (compile-time gate) and works
          const renamed = yield* db.orm.public.User.where({
            id: alice.id,
          }).update({ name: "Alice II" });
          expect(renamed?.name).toEqual("Alice II");

          // @ts-expect-error update without where() is a type error
          db.orm.public.User.update({ name: "nope" });

          // laziness: one effect, two evaluations → two rows
          const insert = db.orm.public.Post.create({
            title: "repeat",
            authorId: alice.id,
          });
          yield* insert;
          yield* insert;
          const repeats = yield* db.orm.public.Post.where({
            title: "repeat",
          }).all();
          expect(repeats).toHaveLength(2);

          const refined = yield* db.orm.public.User.select("id")
            .include("posts", (posts) =>
              posts
                .select("title")
                .orderBy((post) => post.id.desc())
                .limit(2),
            )
            .first();
          expect(refined?.posts).toEqual([
            { title: "repeat" },
            { title: "repeat" },
          ]);
          const combined = yield* db.orm.public.User.select("id")
            .include("posts", (posts) =>
              posts.combine({
                recent: posts
                  .select("title")
                  .orderBy((post) => post.id.desc())
                  .limit(1),
                total: posts.count(),
              }),
            )
            .first();
          expect(combined?.posts).toEqual({
            recent: [{ title: "repeat" }],
            total: 6,
          });
          const grouped = yield* db.orm.public.Post.groupBy("authorId")
            .orderBy((post) => post.authorId.asc())
            .limit(1)
            .aggregate((aggregate) => ({ total: aggregate.count() }));
          expect(grouped).toEqual([{ authorId: alice.id, total: 6 }]);
          const streamedRows = yield* db.orm.public.Post.select("title")
            .orderBy((post) => post.id.asc())
            .all()
            .stream.pipe(Stream.take(2), Stream.runCollect);
          expect([...streamedRows]).toEqual([
            { title: "hello" },
            { title: "bulk-one" },
          ]);
          const page = yield* db.orm.public.Post.orderBy((post) =>
            post.id.asc(),
          )
            .cursor({ id: bulk[0]!.id })
            .limit(1)
            .all();
          expect(page.map((post) => post.title)).toEqual(["bulk-two"]);
          const distinct = yield* db.orm.public.Post.distinct("title")
            .select("title")
            .all();
          expect(distinct).toHaveLength(5);
          const distinctOn = yield* db.orm.public.Post.orderBy([
            (post) => post.title.asc(),
            (post) => post.id.asc(),
          ])
            .distinctOn("title")
            .all();
          expect(distinctOn).toHaveLength(5);
          expect(distinctOn.find((post) => post.title === "repeat")?.id).toBe(
            repeats[0]!.id,
          );
          expect(
            yield* db.orm.public.Post.aggregate((aggregate) => ({
              total: aggregate.count(),
              highestId: aggregate.max("id"),
            })),
          ).toEqual({ total: 6, highestId: repeats[1]!.id });
          expect(
            yield* db.orm.public.Post.groupBy("authorId")
              .having((aggregate) => aggregate.count().gt(6))
              .aggregate((aggregate) => ({ total: aggregate.count() })),
          ).toEqual([]);
          expect(
            yield* db.orm.public.Post.groupBy("authorId")
              .orderBy((post) => post.authorId.asc())
              .offset(1)
              .aggregate((aggregate) => ({ total: aggregate.count() })),
          ).toEqual([]);
          const changed = yield* db.orm.public.Post.where({
            title: "repeat",
          }).updateAll({ title: "updated" });
          expect(changed.map((post) => post.title)).toEqual([
            "updated",
            "updated",
          ]);
          expect(
            yield* db.orm.public.Post.where({
              title: "updated",
            }).updateAndCount({ title: "counted" }),
          ).toBe(2);
          const removed = yield* db.orm.public.Post.where({ title: "counted" })
            .deleteAll()
            .stream.pipe(Stream.runCollect);
          expect(removed).toHaveLength(2);
          expect(
            yield* db.orm.public.Post.where({
              title: "bulk-count",
            }).deleteAndCount(),
          ).toBe(1);
          expect(
            yield* db.orm.public.Post.orderBy((post) => post.id.asc())
              .offset(1)
              .limit(1)
              .first(),
          ).toMatchObject({ title: "bulk-one" });

          // granular constraint tags: unique violation is its own error
          const dup = yield* db.orm.public.User.create({
            email: "alice@example.com",
          }).pipe(
            Effect.as("created" as const),
            Effect.catchTag("Prisma.UniqueViolationError", (error) =>
              Effect.succeed(
                error.sqlState === "23505"
                  ? ("unique" as const)
                  : ("other" as const),
              ),
            ),
          );
          expect(dup).toEqual("unique");

          // ...and so is a foreign-key violation
          const fk = yield* db.orm.public.Post.create({
            title: "orphan",
            authorId: 999_999,
          }).pipe(
            Effect.as("created" as const),
            Effect.catchTag("Prisma.ForeignKeyViolationError", () =>
              Effect.succeed("fk-violation" as const),
            ),
          );
          expect(fk).toEqual("fk-violation");

          // ORM misuse surfaces as the ORM category tag with a typed code.
          // (`count()` is refinement-only; even prisma's own types reject
          // this call, so the cast is deliberate — the test pins the
          // *runtime* classification of the thrown ORM.* error.)
          const misuse = yield* db
            .use(
              (c) =>
                c.orm.public.User.count() as unknown as PromiseLike<unknown>,
            )
            .pipe(
              Effect.as("ok" as const),
              Effect.catchTag("Prisma.OrmError", (error) =>
                Effect.succeed(error.code),
              ),
            );
          expect(misuse).toEqual("ORM.INCLUDE_INVALID");

          // delete gating + row-returning delete
          const deleted = yield* db.orm.public.User.where({
            email: "nobody@example.com",
          }).delete();
          expect(deleted).toBeNull();
        }),
      );

      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:project",
      "provider:prisma",
      "provider:prisma:orm",
      "live",
    ],
    timeout: HOOK_TIMEOUT,
  },
);

test.provider(
  "sql lane, streaming, and transactions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const db = yield* deployDatabase(stack);

      const statement = yield* Effect.scoped(
        Effect.gen(function* () {
          const bob = yield* db.orm.public.User.create({
            email: "bob@example.com",
            name: "Bob",
          });

          // sql builder lane: pure plan, Effect executor, typed rows
          const plan = db.sql.public.user.select("id", "email").build();
          const rows = yield* db.execute(plan);
          expect(rows.map((r) => r.email)).toContain("bob@example.com");

          // stream lane (fresh execution per run)
          const streamed = yield* Stream.runCollect(db.stream(plan));
          expect([...streamed].length).toBe(rows.length);

          const prepared = yield* db.prepare(
            { email: "pg/text@1" },
            (sql, params) =>
              sql.public.user
                .select("id", "email")
                .where((fields, fns) => fns.eq(fields.email, params.email))
                .build(),
          );
          const preparedRead = prepared.query({ email: "bob@example.com" });
          expect(yield* preparedRead).toEqual([
            { id: bob.id, email: "bob@example.com" },
          ]);
          expect(yield* preparedRead).toEqual([
            { id: bob.id, email: "bob@example.com" },
          ]);
          expect([...(yield* Stream.runCollect(preparedRead.stream))]).toEqual([
            { id: bob.id, email: "bob@example.com" },
          ]);
          expect(
            yield* prepared.query({ email: "missing@example.com" }),
          ).toEqual([]);
          const rename = yield* db.prepare(
            { id: "pg/int4@1", name: "pg/text@1" },
            (_sql, params) =>
              db.raw
                .sql`UPDATE "user" SET name = ${params.name} WHERE id = ${params.id}`
                .affectedCount()
                .build(),
          );
          expect(
            yield* rename.execute({ id: bob.id, name: "Prepared Bob" }),
          ).toEqual({ affectedRows: 1 });
          expect(
            (yield* db.orm.public.User.where({ id: bob.id }).first())?.name,
          ).toBe("Prepared Bob");
          const unused = yield* db
            .prepare({ unused: "pg/text@1" }, (sql) =>
              sql.public.user.select("id").build(),
            )
            .pipe(
              Effect.as("unexpected success"),
              Effect.catchTag("Prisma.RuntimeError", (error) =>
                Effect.succeed(error.code),
              ),
            );
          expect(unused).toBe("RUNTIME.PREPARE_UNUSED_PARAM");

          // transaction: commit path
          const committed = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const post = yield* tx.orm.public.Post.create({
                title: "tx-post",
                authorId: bob.id,
              });
              const read = yield* tx.orm.public.Post.where({
                id: post.id,
              }).first();
              return read?.title;
            }),
          );
          expect(committed).toEqual("tx-post");
          const persisted = yield* db.orm.public.Post.where({
            title: "tx-post",
          }).all();
          expect(persisted).toHaveLength(1);

          // transaction: explicit rollback is a typed failure and undoes writes
          const rolledBack = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.orm.public.Post.create({
                  title: "rollback-post",
                  authorId: bob.id,
                });
                const update = yield* tx.prepare(
                  { id: "pg/int4@1", name: "pg/text@1" },
                  (_sql, params) =>
                    db.raw
                      .sql`UPDATE "user" SET name = ${params.name} WHERE id = ${params.id}`
                      .affectedCount()
                      .build(),
                );
                expect(
                  yield* update.execute({ id: bob.id, name: "Rolled back" }),
                ).toEqual({ affectedRows: 1 });
                const read = yield* tx.prepare(
                  { id: "pg/int4@1" },
                  (sql, params) =>
                    sql.public.user
                      .select("name")
                      .where((fields, fns) => fns.eq(fields.id, params.id))
                      .build(),
                );
                expect(yield* read.query({ id: bob.id })).toEqual([
                  { name: "Rolled back" },
                ]);
                return yield* tx.rollback();
              }),
            )
            .pipe(
              Effect.as("committed" as const),
              Effect.catchTag("Prisma.RollbackError", () =>
                Effect.succeed("rolled-back" as const),
              ),
            );
          expect(rolledBack).toEqual("rolled-back");
          expect(
            (yield* db.orm.public.User.where({ id: bob.id }).first())?.name,
          ).toBe("Prepared Bob");
          expect(
            yield* db.orm.public.Post.where({ title: "rollback-post" }).all(),
          ).toHaveLength(0);

          // transaction: a failing effect rolls back too
          const failed = yield* Effect.result(
            db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.orm.public.Post.create({
                  title: "failed-post",
                  authorId: bob.id,
                });
                // unique violation aborts the transaction
                yield* tx.orm.public.User.create({
                  email: "bob@example.com",
                });
              }),
            ),
          );
          expect(Result.isFailure(failed)).toBe(true);
          expect(
            yield* db.orm.public.Post.where({ title: "failed-post" }).all(),
          ).toHaveLength(0);
          return prepared;
        }),
      );

      const later = yield* statement
        .query({ email: "bob@example.com" })
        .pipe(Effect.scoped);
      expect(later.map((row) => row.email)).toEqual(["bob@example.com"]);
      const concurrent = yield* Effect.all(
        ["bob@example.com", "missing@example.com"].map((email) =>
          statement.query({ email }).pipe(Effect.scoped),
        ),
        { concurrency: 2 },
      );
      expect(concurrent.map((rows) => rows.length)).toEqual([1, 0]);

      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:project",
      "provider:prisma",
      "provider:prisma:orm",
      "live",
    ],
    timeout: HOOK_TIMEOUT,
  },
);
