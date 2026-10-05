#!/usr/bin/env -S bun
import type { Contract as End } from "../../snapshots/66e56baf5738e4a1532031ff94449ba28606415894bcee88665631247dc3da89/contract";
import endContract from "../../snapshots/66e56baf5738e4a1532031ff94449ba28606415894bcee88665631247dc3da89/contract.json" with { type: "json" };
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
        table: "assignee",
        columns: [
          col("id", "SERIAL", {
            notNull: true,
            codecRef: { codecId: "pg/int4@1" },
          }),
          col("name", "text", {
            notNull: true,
            codecRef: { codecId: "pg/text@1" },
          }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.createTable({
        schema: "public",
        table: "features",
        columns: [
          col("id", "int4", {
            notNull: true,
            codecRef: { codecId: "pg/int4@1" },
          }),
          col("priority", "int4", {
            notNull: true,
            codecRef: { codecId: "pg/int4@1" },
          }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.createTable({
        schema: "public",
        table: "tasks",
        columns: [
          col("assigneeId", "int4", { codecRef: { codecId: "pg/int4@1" } }),
          col("id", "SERIAL", {
            notNull: true,
            codecRef: { codecId: "pg/int4@1" },
          }),
          col("severity", "text", { codecRef: { codecId: "pg/text@1" } }),
          col("title", "text", {
            notNull: true,
            codecRef: { codecId: "pg/text@1" },
          }),
          col("type", "text", {
            notNull: true,
            codecRef: { codecId: "pg/text@1" },
          }),
        ],
        constraints: [primaryKey(["id"])],
      }),
      this.addForeignKey({
        schema: "public",
        table: "features",
        foreignKey: {
          name: "features_id_fkey",
          columns: ["id"],
          references: { schema: "public", table: "tasks", columns: ["id"] },
          onDelete: "cascade",
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
