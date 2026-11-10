import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle/LibSQL";
import * as SQL from "@alchemy.run/sql/SQLite";
import * as Turso from "@alchemy.run/turso";
import { createClient } from "@libsql/client/web";
import { defineRelations, sql as drizzleSql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { BindingDb, TenantGroup } from "./resources.ts";

const notes = sqliteTable("notes", {
  id: integer("id").primaryKey(),
  body: text("body").notNull(),
});

const authors = sqliteTable("authors", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

const posts = sqliteTable("posts", {
  id: integer("id").primaryKey(),
  authorId: integer("author_id").notNull(),
  title: text("title").notNull(),
});

const relations = defineRelations({ authors, posts }, (t) => ({
  authors: { posts: t.many.posts() },
  posts: { author: t.one.authors({ from: t.posts.authorId, to: t.authors.id }) },
}));

export default class TursoWorker extends Cloudflare.Worker<TursoWorker>()(
  "TursoWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const conn = yield* Turso.Connect(BindingDb);
    const sql = yield* SQL.LibSQL(conn);
    const db = yield* Drizzle.LibSQL(conn);
    const related = yield* Drizzle.LibSQL(conn, { relations });
    const tenants = yield* Turso.ManageDatabases(TenantGroup);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");

        if (url.pathname === "/sql") {
          yield* sql`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`;
          yield* sql`INSERT INTO notes (body) VALUES (${"from-sql"})`;
          const rows = yield* sql<{ n: number }>`SELECT count(*) AS n FROM notes`;
          return yield* HttpServerResponse.json({ count: rows[0]?.n });
        }

        if (url.pathname === "/relations") {
          yield* sql`CREATE TABLE IF NOT EXISTS authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
          yield* sql`CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL, title TEXT NOT NULL)`;
          yield* sql`INSERT OR REPLACE INTO authors (id, name) VALUES (1, 'ada')`;
          yield* sql`INSERT OR REPLACE INTO posts (id, author_id, title) VALUES (1, 1, 'engines')`;
          const author = yield* related.query.authors.findFirst({
            where: { id: 1 },
            with: { posts: true },
          });
          return yield* HttpServerResponse.json({ author });
        }

        if (url.pathname === "/client") {
          const client = createClient({
            url: yield* conn.url,
            authToken: Redacted.value(yield* conn.authToken),
          });
          const result = yield* Effect.promise(() => client.execute("SELECT 7 AS seven"));
          client.close();
          return yield* HttpServerResponse.json({ seven: result.rows[0]?.seven });
        }

        if (url.pathname === "/tx") {
          yield* sql`CREATE TABLE IF NOT EXISTS ledger (v INTEGER NOT NULL)`;
          const before = yield* sql<{ n: number }>`SELECT count(*) AS n FROM ledger`;
          // The second insert violates NOT NULL, so the first must roll back.
          const failed = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO ledger (v) VALUES (${1})`;
                yield* sql`INSERT INTO ledger (v) VALUES (${null})`;
              }),
            )
            .pipe(
              Effect.as(false),
              Effect.catchTag("SqlError", () => Effect.succeed(true)),
            );
          const after = yield* sql<{ n: number }>`SELECT count(*) AS n FROM ledger`;
          return yield* HttpServerResponse.json({
            failed,
            before: before[0]?.n,
            after: after[0]?.n,
          });
        }

        if (url.pathname === "/drizzle") {
          yield* db.insert(notes).values({ body: "from-drizzle" });
          const rows = yield* db
            .select()
            .from(notes)
            .where(drizzleSql`body = 'from-drizzle'`);
          return yield* HttpServerResponse.json({ bodies: rows.map((r) => r.body) });
        }

        if (url.pathname === "/tenant") {
          const name = url.searchParams.get("name")!;
          const created = yield* tenants.create(name);
          const tenantSql = yield* SQL.LibSQL(tenants.connect(created.name));
          yield* tenantSql`CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)`;
          yield* tenantSql`INSERT INTO kv VALUES ('tenant', ${name})`;
          const rows = yield* tenantSql<{ v: string }>`SELECT v FROM kv`;
          const listed = yield* tenants.list();
          yield* tenants.delete(created.name);
          const afterDelete = yield* tenants.get(created.name);
          return yield* HttpServerResponse.json({
            url: created.url,
            value: rows[0]?.v,
            listed: listed.map((d) => d.name),
            deleted: afterDelete === undefined,
          });
        }

        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Turso.ConnectHttp, Turso.ManageDatabasesHttp))),
) {}
