import { stripSslQueryParams } from "@alchemy.run/sql/PostgresDriver";
import {
  applySqlImports,
  splitSqliteStatements,
  splitSqlStatements,
} from "@alchemy.run/sql/SqlFile";
import { describe, expect, layer, test } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

describe("SqlFile", { tags: ["unit", "local"] }, () => {
  describe("splitSqlStatements", () => {
    test("splits statements separated by breakpoints on their own line", () => {
      const sql = [
        "CREATE TABLE `users` (\n\t`id` int NOT NULL\n);",
        "--> statement-breakpoint",
        "CREATE TABLE `sessions` (\n\t`id` int NOT NULL\n);",
      ].join("\n");
      expect(splitSqlStatements(sql)).toEqual([
        "CREATE TABLE `users` (\n\t`id` int NOT NULL\n);",
        "CREATE TABLE `sessions` (\n\t`id` int NOT NULL\n);",
      ]);
    });

    // drizzle-kit puts the marker on the same line after single-line
    // statements (`...;--> statement-breakpoint`). A newline-anchored split
    // misses those, and the leftover `-->` makes Vitess bail with
    // "syntax error at position 2".
    test("splits breakpoints appended on the same line as the statement", () => {
      const sql = [
        "CREATE TABLE `users` (\n\t`id` int NOT NULL\n);",
        "--> statement-breakpoint",
        "CREATE INDEX `users_email` ON `users` (`email`);--> statement-breakpoint",
        "CREATE INDEX `users_name` ON `users` (`name`);",
      ].join("\n");
      expect(splitSqlStatements(sql)).toEqual([
        "CREATE TABLE `users` (\n\t`id` int NOT NULL\n);",
        "CREATE INDEX `users_email` ON `users` (`email`);",
        "CREATE INDEX `users_name` ON `users` (`name`);",
      ]);
    });

    test("splits CRLF-separated breakpoints", () => {
      const sql =
        "CREATE TABLE `users` (`id` int);\r\n--> statement-breakpoint\r\nCREATE TABLE `sessions` (`id` int);";
      expect(splitSqlStatements(sql)).toEqual([
        "CREATE TABLE `users` (`id` int);",
        "CREATE TABLE `sessions` (`id` int);",
      ]);
    });

    test("drops empty segments and keeps sql without markers intact", () => {
      expect(splitSqlStatements("--> statement-breakpoint\n")).toEqual([]);
      expect(splitSqlStatements("SELECT 1;")).toEqual(["SELECT 1;"]);
    });
  });

  describe("splitSqliteStatements", () => {
    test("splits on semicolons and drops the terminators", () => {
      expect(
        splitSqliteStatements("CREATE TABLE t (id INTEGER);\nINSERT INTO t VALUES (1);\n"),
      ).toEqual(["CREATE TABLE t (id INTEGER)", "INSERT INTO t VALUES (1)"]);
    });

    test("keeps a final statement without a semicolon", () => {
      expect(splitSqliteStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
    });

    test("ignores semicolons inside strings, quoted identifiers, and comments", () => {
      const sql = [
        "INSERT INTO t VALUES ('a;b', 'it''s; fine');",
        'CREATE TABLE "x;y" (`a;` TEXT, [b;] TEXT);',
        "-- a comment; not a statement",
        "/* block; comment */ SELECT 1;",
      ].join("\n");
      expect(splitSqliteStatements(sql)).toEqual([
        "INSERT INTO t VALUES ('a;b', 'it''s; fine')",
        'CREATE TABLE "x;y" (`a;` TEXT, [b;] TEXT)',
        "-- a comment; not a statement\n/* block; comment */ SELECT 1",
      ]);
    });

    test("keeps a trigger body as one statement", () => {
      const trigger = [
        "CREATE TEMP TRIGGER log_insert AFTER INSERT ON t",
        "BEGIN",
        "  INSERT INTO log VALUES (new.id);",
        "  UPDATE counts SET n = n + 1;",
        "END",
      ].join("\n");
      expect(splitSqliteStatements(`${trigger};\nSELECT 1;`)).toEqual([trigger, "SELECT 1"]);
    });

    test("drops comment-only and empty segments", () => {
      expect(splitSqliteStatements(";;\n-- only a comment\n")).toEqual([]);
      expect(splitSqliteStatements("")).toEqual([]);
    });
  });
});

const withFs = layer(NodeServices.layer);

withFs("applySqlImports", (it) => {
  it.effect(
    "applies new and changed files once, and keeps hashes only for listed files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const rootDir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-imports-" });
        yield* fs.writeFileString(path.join(rootDir, "a.sql"), "SELECT 1;");
        yield* fs.writeFileString(path.join(rootDir, "b.sql"), "SELECT 2;");
        const applied: string[] = [];
        const apply = (file: { id: string }) => Effect.sync(() => void applied.push(file.id));

        const first = yield* applySqlImports({
          importFiles: ["a.sql", "b.sql"],
          rootDir,
          previous: { "gone.sql": "stale" },
          apply,
        });
        expect(Object.keys(first).sort()).toEqual(["a.sql", "b.sql"]);

        yield* fs.writeFileString(path.join(rootDir, "b.sql"), "SELECT 3;");
        const second = yield* applySqlImports({
          importFiles: ["a.sql", "b.sql"],
          rootDir,
          previous: first,
          apply,
        });
        expect(second["a.sql"]).toEqual(first["a.sql"]);
        expect(second["b.sql"]).not.toEqual(first["b.sql"]);
        expect(applied).toEqual(["a.sql", "b.sql", "b.sql"]);
      }),
    { tags: ["unit", "local"] },
  );
});

describe("stripSslQueryParams", { tags: ["unit", "local"] }, () => {
  test("drops sslmode and channel_binding and keeps everything else", () => {
    expect(
      stripSslQueryParams(
        "postgresql://u:p@host/db?sslmode=require&channel_binding=require&application_name=x",
      ),
    ).toEqual("postgresql://u:p@host/db?application_name=x");
    expect(stripSslQueryParams("not a url")).toEqual("not a url");
  });
});
