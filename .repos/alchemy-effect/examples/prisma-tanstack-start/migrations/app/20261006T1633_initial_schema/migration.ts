#!/usr/bin/env -S node
import { Migration, MigrationCLI, col, fn, primaryKey } from "@prisma/orm-postgres/migration";
import type { Contract as End } from "../../snapshots/f32b3c3cf6335c4b528aa6d8233d0d9ffa0a87cd175963c0b6665ccebcf99793/contract";
import endContract from "../../snapshots/f32b3c3cf6335c4b528aa6d8233d0d9ffa0a87cd175963c0b6665ccebcf99793/contract.json" with { type: "json" };

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: "public" }),
      this.createTable({
        schema: "public",
        table: "post",
        columns: [
          col("createdAt", "timestamptz", {
            notNull: true,
            default: fn("now()"),
            codecRef: { codecId: "pg/timestamptz-temporal@1" },
          }),
          col("excerpt", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("id", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("title", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("userId", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.createTable({
        schema: "public",
        table: "user",
        columns: [
          col("createdAt", "timestamptz", {
            notNull: true,
            default: fn("now()"),
            codecRef: { codecId: "pg/timestamptz-temporal@1" },
          }),
          col("email", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("id", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
          col("name", "text", { notNull: true, codecRef: { codecId: "pg/text@1" } }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.createIndex({
        schema: "public",
        table: "post",
        index: "post_userId_idx_a489d58a",
        columns: ["userId"],
      }),
      this.addForeignKey({
        schema: "public",
        table: "post",
        foreignKey: {
          name: "post_userId_fkey",
          columns: ["userId"],
          references: { schema: "public", table: "user", columns: ["id"] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
