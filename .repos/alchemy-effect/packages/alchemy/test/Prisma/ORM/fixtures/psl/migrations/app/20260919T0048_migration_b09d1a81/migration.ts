#!/usr/bin/env -S bun
import type { Contract as End } from "../../snapshots/b09d1a81a21c191e35c6d2e6bbb462154b005582529fa8120638576d8ee3cd1d/contract";
import endContract from "../../snapshots/b09d1a81a21c191e35c6d2e6bbb462154b005582529fa8120638576d8ee3cd1d/contract.json" with { type: "json" };
import {
  Migration,
  MigrationCLI,
  col,
  primaryKey,
} from "@prisma/orm-postgres/migration";

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: "public" }),
      this.createTable({
        schema: "public",
        table: "post",
        columns: [
          col("authorId", "int4", {
            notNull: true,
            codecRef: { codecId: "pg/int4@1" },
          }),
          col("id", "SERIAL", {
            notNull: true,
            codecRef: { codecId: "pg/int4@1" },
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
          col("email", "text", {
            notNull: true,
            codecRef: { codecId: "pg/text@1" },
          }),
          col("id", "SERIAL", {
            notNull: true,
            codecRef: { codecId: "pg/int4@1" },
          }),
          col("name", "text", { codecRef: { codecId: "pg/text@1" } }),
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
