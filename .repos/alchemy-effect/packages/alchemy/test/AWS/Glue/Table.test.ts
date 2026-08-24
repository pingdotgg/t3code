import * as AWS from "@/AWS";
import { Database, Table } from "@/AWS/Glue";
import * as Test from "@/Test/Alchemy";
import * as glue from "@distilled.cloud/aws/glue";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getTable = (databaseName: string, name: string) =>
  glue.getTable({ DatabaseName: databaseName, Name: name }).pipe(
    Effect.map((r) => r.Table),
    Effect.catchTag("EntityNotFoundException", () => Effect.succeed(undefined)),
  );

test.provider("create, update, delete Glue table over a database", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    // create database + parquet table
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const database = yield* Database("AnalyticsDb", {});
        const table = yield* Table("Events", {
          databaseName: database.databaseName,
          tableType: "EXTERNAL_TABLE",
          storageDescriptor: {
            location: "s3://example-bucket/events/",
            inputFormat:
              "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
            outputFormat:
              "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
            serdeInfo: {
              serializationLibrary:
                "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
            },
            columns: [
              { name: "id", type: "string" },
              { name: "amount", type: "double" },
            ],
          },
          partitionKeys: [{ name: "dt", type: "string" }],
          parameters: { classification: "parquet" },
        });
        return { database, table };
      }),
    );

    expect(created.table.tableName).toBeDefined();
    expect(created.table.databaseName).toEqual(created.database.databaseName);
    expect(created.table.tableArn).toContain(
      `:table/${created.database.databaseName}/${created.table.tableName}`,
    );

    // out-of-band verification
    const observed = yield* getTable(
      created.database.databaseName,
      created.table.tableName,
    );
    expect(observed?.Name).toEqual(created.table.tableName);
    expect(observed?.TableType).toEqual("EXTERNAL_TABLE");
    expect(observed?.StorageDescriptor?.Location).toEqual(
      "s3://example-bucket/events/",
    );
    expect(observed?.StorageDescriptor?.Columns?.map((c) => c.Name)).toEqual([
      "id",
      "amount",
    ]);
    expect(observed?.PartitionKeys?.map((c) => c.Name)).toEqual(["dt"]);
    expect(observed?.Parameters?.classification).toEqual("parquet");
    expect(observed?.Parameters?.["alchemy::id"]).toBeDefined();

    // update: add a column + change a parameter
    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        const database = yield* Database("AnalyticsDb", {});
        const table = yield* Table("Events", {
          databaseName: database.databaseName,
          tableType: "EXTERNAL_TABLE",
          storageDescriptor: {
            location: "s3://example-bucket/events-v2/",
            inputFormat:
              "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
            outputFormat:
              "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
            serdeInfo: {
              serializationLibrary:
                "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
            },
            columns: [
              { name: "id", type: "string" },
              { name: "amount", type: "double" },
              { name: "currency", type: "string" },
            ],
          },
          partitionKeys: [{ name: "dt", type: "string" }],
          parameters: { classification: "parquet", owner: "analytics" },
        });
        return { database, table };
      }),
    );

    expect(updated.table.tableName).toEqual(created.table.tableName);
    const reobserved = yield* getTable(
      created.database.databaseName,
      created.table.tableName,
    );
    expect(reobserved?.StorageDescriptor?.Location).toEqual(
      "s3://example-bucket/events-v2/",
    );
    expect(reobserved?.StorageDescriptor?.Columns?.map((c) => c.Name)).toEqual([
      "id",
      "amount",
      "currency",
    ]);
    expect(reobserved?.Parameters?.owner).toEqual("analytics");

    // delete
    yield* stack.destroy();
    const gone = yield* getTable(
      created.database.databaseName,
      created.table.tableName,
    );
    expect(gone).toBeUndefined();
  }),
);
