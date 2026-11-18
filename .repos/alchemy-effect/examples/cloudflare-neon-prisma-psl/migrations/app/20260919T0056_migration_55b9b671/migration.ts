#!/usr/bin/env -S bun
import { Migration, MigrationCLI, col, fn, primaryKey } from "@prisma/orm-postgres/migration";
import type { Contract as End } from "../../snapshots/55b9b6715d228453c726947eaa87ebbd9ca24c38185277c672b1096c6e8effde/contract";
import endContract from "../../snapshots/55b9b6715d228453c726947eaa87ebbd9ca24c38185277c672b1096c6e8effde/contract.json" with { type: "json" };

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: "public" }),
      this.createTable({
        schema: "public",
        table: "post",
        columns: [
          col("authorId", "uuid", {
            notNull: true,
            codecRef: { codecId: "pg/uuid@1" },
          }),
          col("id", "uuid", {
            notNull: true,
            codecRef: { codecId: "pg/uuid@1" },
          }),
          col("title", "text", {
            notNull: true,
            codecRef: { codecId: "pg/text@1" },
          }),
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
            codecRef: { codecId: "pg/timestamptz-string@1" },
          }),
          col("email", "text", {
            notNull: true,
            codecRef: { codecId: "pg/text@1" },
          }),
          col("id", "uuid", {
            notNull: true,
            codecRef: { codecId: "pg/uuid@1" },
          }),
          col("name", "text", {
            notNull: true,
            codecRef: { codecId: "pg/text@1" },
          }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.addUnique({
        schema: "public",
        table: "user",
        constraint: "user_email_key",
        columns: ["email"],
      }),
      this.createIndex({
        schema: "public",
        table: "post",
        index: "post_authorId_idx_e47547ed",
        columns: ["authorId"],
      }),
      this.addForeignKey({
        schema: "public",
        table: "post",
        foreignKey: {
          name: "post_authorId_fkey",
          columns: ["authorId"],
          references: { schema: "public", table: "user", columns: ["id"] },
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
