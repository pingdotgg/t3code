#!/usr/bin/env -S node
import type { Contract as End } from "../../snapshots/03524e20386e10a155733715778d8ff1bb8d54ad14d4d11110c0a4de5e4864d6/contract";
import endContract from "../../snapshots/03524e20386e10a155733715778d8ff1bb8d54ad14d4d11110c0a4de5e4864d6/contract.json" with { type: "json" };
import {
  Migration,
  MigrationCLI,
  col,
  primaryKey,
} from "@internal/postgres/migration";

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: "public" }),
      this.createTable({
        schema: "public",
        table: "widget",
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
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
