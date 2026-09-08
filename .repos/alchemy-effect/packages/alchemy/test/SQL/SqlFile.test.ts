import { splitSqlStatements } from "@/SQL/SqlFile";
import { describe, expect, test } from "alchemy-test";

describe("SqlFile", () => {
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
});
