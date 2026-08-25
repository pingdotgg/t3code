import * as AWS from "@/AWS";
import { Keyspace, Table } from "@/AWS/Keyspaces";
import * as Test from "@/Test/Alchemy";
import * as keyspaces from "@distilled.cloud/aws/keyspaces";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getTable = (keyspaceName: string, tableName: string) =>
  keyspaces
    .getTable({ keyspaceName, tableName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

test.provider(
  "create, add column, delete Keyspaces table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const ksName = "alchemy_tbl_test_ks";

      // create keyspace + table
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const keyspace = yield* Keyspace("Ks", { keyspaceName: ksName });
          const table = yield* Table("Events", {
            keyspaceName: keyspace.keyspaceName,
            tableName: "events",
            columns: [
              { name: "device", type: "text" },
              { name: "ts", type: "timestamp" },
              { name: "payload", type: "blob" },
            ],
            partitionKeys: ["device"],
            clusteringKeys: [{ name: "ts", orderBy: "DESC" }],
            pointInTimeRecovery: true,
          });
          return { table };
        }),
      );

      expect(created.table.tableName).toEqual("events");
      expect(created.table.status).toEqual("ACTIVE");

      // out-of-band verification
      const observed = yield* getTable(ksName, "events");
      expect(observed?.status).toEqual("ACTIVE");
      expect(observed?.pointInTimeRecovery?.status).toEqual("ENABLED");
      const cols = new Set(
        (observed?.schemaDefinition?.allColumns ?? []).map((c) => c.name),
      );
      expect(cols.has("device")).toBe(true);
      expect(cols.has("payload")).toBe(true);

      // update: add a column in place
      yield* stack.deploy(
        Effect.gen(function* () {
          const keyspace = yield* Keyspace("Ks", { keyspaceName: ksName });
          const table = yield* Table("Events", {
            keyspaceName: keyspace.keyspaceName,
            tableName: "events",
            columns: [
              { name: "device", type: "text" },
              { name: "ts", type: "timestamp" },
              { name: "payload", type: "blob" },
              { name: "region", type: "text" },
            ],
            partitionKeys: ["device"],
            clusteringKeys: [{ name: "ts", orderBy: "DESC" }],
            pointInTimeRecovery: true,
          });
          return { table };
        }),
      );
      const reobserved = yield* getTable(ksName, "events");
      const reCols = new Set(
        (reobserved?.schemaDefinition?.allColumns ?? []).map((c) => c.name),
      );
      expect(reCols.has("region")).toBe(true);

      // delete
      yield* stack.destroy();
      const gone = yield* getTable(ksName, "events");
      expect(gone).toBeUndefined();
    }),
  { timeout: 300_000 },
);
