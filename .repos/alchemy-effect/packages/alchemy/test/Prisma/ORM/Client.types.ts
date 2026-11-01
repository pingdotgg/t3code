import type { MetaBuilder } from "@prisma/orm-postgres/components/runtime";
import { and } from "@prisma/orm-postgres/orm-client";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ClientError, PostgresDatabase } from "@/Prisma/ORM/Postgres.ts";
import type { contract } from "./fixtures/client/contract.ts";

type Contract = typeof contract;

/** Checks native contract inference through the Effect client. */
export function clientTypes(db: PostgresDatabase<Contract>) {
  const selected: Effect.Effect<
    Array<{ id: number; email: string }>,
    ClientError
  > = db.orm.public.User.select("id", "email").all();
  const annotated = db.orm.public.User.all((meta) => {
    const read: MetaBuilder<"read"> = meta;
  });
  const streamed: Stream.Stream<{ id: number }, ClientError> =
    db.orm.public.User.select("id").all().stream;
  const filtered = db.orm.public.User.where((user) =>
    and(user.id.gt(0), user.email.neq("nobody@example.com")),
  );
  const cursor = filtered.orderBy((user) => user.id.asc()).cursor({ id: 1 });
  const distinct = db.orm.public.User.distinct("name").all();
  const distinctOn = db.orm.public.User.orderBy((user) => user.name.asc())
    .distinctOn("name")
    .all();
  // @ts-expect-error cursors require an ordering
  db.orm.public.User.cursor({ id: 1 });
  // @ts-expect-error DISTINCT ON requires an ordering
  db.orm.public.User.distinctOn("name");
  // @ts-expect-error field names remain model-specific
  db.orm.public.User.distinct("missing");
  // @ts-expect-error writes require a filter
  db.orm.public.User.update({ name: "unsafe" });
  // @ts-expect-error deletes require a filter
  db.orm.public.User.deleteAll();

  const posts: Effect.Effect<
    Array<{ id: number; posts: { title: string }[] }>,
    ClientError
  > = db.orm.public.User.select("id")
    .include("posts", (posts) =>
      posts
        .select("title")
        .orderBy((post) => post.id.desc())
        .limit(2),
    )
    .all();
  const counts: Effect.Effect<
    Array<{ id: number; posts: number }>,
    ClientError
  > = db.orm.public.User.select("id")
    .include("posts", (posts) => posts.count())
    .all();
  const combined: Effect.Effect<
    Array<{
      id: number;
      posts: { recent: { title: string }[]; total: number };
    }>,
    ClientError
  > = db.orm.public.User.select("id")
    .include("posts", (posts) =>
      posts.combine({
        recent: posts.select("title").limit(2),
        total: posts.count(),
      }),
    )
    .all();
  const author: Effect.Effect<
    Array<{
      title: string;
      author: { id: number; email: string; name: string | null };
    }>,
    ClientError
  > = db.orm.public.Post.select("title").include("author").all();
  const refinedAuthor: Effect.Effect<
    Array<{ title: string; author: { email: string } | null }>,
    ClientError
  > = db.orm.public.Post.select("title")
    .include("author", (author) => author.select("email"))
    .all();
  // @ts-expect-error refinement callbacks construct queries rather than executing them
  db.orm.public.User.include("posts", (posts) => posts.all());
  // @ts-expect-error scalar reducers only apply to to-many relations
  db.orm.public.Post.include("author", (author) => author.count());
  db.orm.public.Post.include("author", (author) => {
    // @ts-expect-error combine only applies to to-many relations
    return author.combine({ row: author });
  });

  const grouped: Effect.Effect<
    Array<{ authorId: number; total: number }>,
    ClientError
  > = db.orm.public.Post.groupBy("authorId")
    .orderBy((post) => post.authorId.asc())
    .limit(2)
    .aggregate((aggregate) => ({ total: aggregate.count() }));
  // @ts-expect-error grouped pagination requires an ordering
  db.orm.public.Post.groupBy("authorId").limit(2);
  // @ts-expect-error grouped ordering is restricted to group keys
  db.orm.public.Post.groupBy("authorId").orderBy((post) => post.title.asc());
  db.orm.public.User.createAll([
    // @ts-expect-error bulk inserts cannot perform nested relation writes
    { email: "nested@example.com", posts: () => [] },
  ]);

  const prepared = Effect.gen(function* () {
    const query = yield* db.prepare({ email: "pg/text@1" }, (sql, params) =>
      sql.public.user
        .select("id", "email")
        .where((fields, fns) => fns.eq(fields.email, params.email))
        .build(),
    );
    const rows: Effect.Effect<
      Array<{ id: number; email: string }>,
      ClientError
    > = query.query({ email: "alice@example.com" });
    const stream: Stream.Stream<{ id: number; email: string }, ClientError> =
      query.query({ email: "alice@example.com" }).stream;
    // @ts-expect-error prepared parameters preserve codec input types
    query.query({ email: 123 });
    // @ts-expect-error row-returning statements are queried, not executed for statistics
    query.execute({ email: "alice@example.com" });
    const mutation = yield* db.prepare(
      { name: "pg/text@1", id: "pg/int4@1" },
      (_sql, params) =>
        db.raw
          .sql`UPDATE "user" SET name = ${params.name} WHERE id = ${params.id}`
          .affectedCount()
          .build(),
    );
    const stats: Effect.Effect<{ affectedRows: number }, ClientError> =
      mutation.execute({ name: "Alice", id: 1 });
    // @ts-expect-error mutations report statistics rather than rows
    mutation.query({ name: "Alice", id: 1 });
    // @ts-expect-error numeric codec parameters reject strings
    mutation.execute({ name: "Alice", id: "1" });
    return { rows, stream, stats };
  });
  return {
    selected,
    annotated,
    streamed,
    cursor,
    distinct,
    distinctOn,
    posts,
    counts,
    combined,
    author,
    refinedAuthor,
    grouped,
    prepared,
  };
}
