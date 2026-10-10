#!/usr/bin/env -S node
import {
  Migration,
  MigrationCLI,
  addForeignKey,
  createIndex,
  createTable,
} from "@prisma-next/target-postgres/migration";

export default class M extends Migration {
  override describe() {
    return {
      from: null,
      to: "sha256:ae5cf43e83687e08354eb6afa512ad5834d96164612280b204c5b7103b01e8e1",
    };
  }

  override get operations() {
    return [
      createTable(
        "public",
        "post",
        [
          {
            name: "createdAt",
            typeSql: "timestamptz",
            defaultSql: "DEFAULT (now())",
            nullable: false,
          },
          { name: "excerpt", typeSql: "text", defaultSql: "", nullable: false },
          {
            name: "id",
            typeSql: "character(36)",
            defaultSql: "",
            nullable: false,
          },
          { name: "title", typeSql: "text", defaultSql: "", nullable: false },
          { name: "userId", typeSql: "text", defaultSql: "", nullable: false },
        ],
        { columns: ["id"] },
      ),
      createTable(
        "public",
        "user",
        [
          {
            name: "createdAt",
            typeSql: "timestamptz",
            defaultSql: "DEFAULT (now())",
            nullable: false,
          },
          { name: "email", typeSql: "text", defaultSql: "", nullable: false },
          {
            name: "id",
            typeSql: "character(36)",
            defaultSql: "",
            nullable: false,
          },
          { name: "name", typeSql: "text", defaultSql: "", nullable: false },
        ],
        { columns: ["id"] },
      ),
      createIndex("public", "post", "post_userId_idx", ["userId"]),
      addForeignKey("public", "post", {
        name: "post_userId_fkey",
        columns: ["userId"],
        references: { table: "user", columns: ["id"] },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
