import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Basin from "@alchemy.run/cloudflare/Basin";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as basin from "@distilled.cloud/cloudflare/basin_catalog";
import * as Iceberg from "@distilled.cloud/iceberg";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const tags = ["provider:cloudflare", "provider:cloudflare:r2", "live"];

const OrderV1 = S.Struct({
  id: S.String,
  amount: S.Number,
  quantity: S.Int,
  at: S.Date,
  note: S.optional(S.String),
});

const OrderV2 = S.Struct({
  ...OrderV1.fields,
  coupon: S.optional(S.String),
  lines: S.optional(S.Array(S.Struct({ sku: S.String, qty: S.Int }))),
});

// Drops `amount` and `quantity`.
const OrderDestructive = S.Struct({
  id: S.String,
  at: S.Date,
  note: S.optional(S.String),
});

type TableOpts = Omit<Basin.TableProps, "catalog" | "namespace" | "schema"> & {
  schema?: Basin.TableSchemaInput;
};

const apiToken = Effect.gen(function* () {
  const creds = yield* yield* CloudflareEnvironment;
  if (creds.type !== "apiToken") {
    return yield* Effect.die(new Error("Basin Table tests require an API token profile"));
  }
  return creds.apiToken;
});

// Bucket + catalog + any number of tables, one stack program.
const program = (
  token: Redacted.Redacted<string>,
  tables: Record<string, TableOpts>,
  catalogMaintenance: Pick<
    Cloudflare.R2.DataCatalogProps,
    "compaction" | "snapshotExpiration"
  > = {},
) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("TableBucket", { forceDestroy: true });
    const catalog = yield* Cloudflare.R2.DataCatalog("TableCatalog", {
      bucket,
      token,
      ...catalogMaintenance,
    });
    const out: Record<string, Basin.Table> = {};
    for (const [id, opts] of Object.entries(tables)) {
      out[id] = yield* Basin.Table(id, {
        catalog,
        namespace: "sales",
        schema: OrderV1,
        ...opts,
      });
    }
    return { bucket, catalog, tables: out };
  });

// Out-of-band Iceberg client scoped to the deployed warehouse.
const iceberg =
  (catalog: { catalogUri: string; name: string }, token: Redacted.Redacted<string>) =>
  <A, E, R>(eff: Effect.Effect<A, E, R>) =>
    eff.pipe(
      Effect.provide(
        Layer.mergeAll(
          Iceberg.IcebergProtocol,
          Iceberg.fromCatalogConfig({ uri: catalog.catalogUri, warehouse: catalog.name, token }),
        ),
      ),
    );

const currentFields = (metadata: Iceberg.TableMetadata) =>
  (metadata.schemas ?? []).find((s) => s.schema_id === metadata.current_schema_id)?.fields ?? [];

const exists = (namespace: string, table: string) =>
  Iceberg.tableExists({ namespace, table }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create, evolve the schema in place, sync properties, reject destructive changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const token = yield* apiToken;

      const v1 = yield* stack.deploy(
        program(token, {
          Orders: {
            partitionBy: ["day(at)"],
            properties: { "alchemy.test.a": "1", "alchemy.test.b": "2" },
          },
        }),
      );
      const orders = v1.tables.Orders!;
      expect(orders.namespace).toEqual("sales");
      expect(orders.identifier).toEqual(`sales.${orders.tableName}`);
      expect(orders.tableName).toMatch(/^[a-z0-9_]+$/);
      expect(orders.warehouse).toEqual(v1.catalog.name);
      expect(orders.catalogUri).toEqual(v1.catalog.catalogUri);

      const withCatalog = iceberg(v1.catalog, token);
      const live1 = yield* Iceberg.loadTable({
        namespace: "sales",
        table: orders.tableName,
      }).pipe(withCatalog);
      expect(live1.metadata.table_uuid).toEqual(orders.tableUuid);
      const fields1 = currentFields(live1.metadata);
      expect(fields1.map((f) => f.name)).toEqual(["id", "amount", "quantity", "at", "note"]);
      expect(fields1.find((f) => f.name === "at")?.type).toEqual("timestamptz");
      expect(fields1.find((f) => f.name === "quantity")?.type).toEqual("long");
      expect(fields1.find((f) => f.name === "note")?.required).toBe(false);
      const spec = live1.metadata.partition_specs?.find(
        (s) => s.spec_id === live1.metadata.default_spec_id,
      );
      expect(spec?.fields.map((f) => f.transform)).toEqual(["day"]);
      expect(live1.metadata.properties?.["alchemy.test.a"]).toEqual("1");
      expect(live1.metadata.properties?.["alchemy.test.b"]).toEqual("2");
      expect(live1.metadata.properties?.["alchemy::id"]).toEqual("Orders");

      // Additive evolution + property sync: same table, new schema.
      const v2 = yield* stack.deploy(
        program(token, {
          Orders: {
            schema: OrderV2,
            partitionBy: ["day(at)"],
            properties: { "alchemy.test.a": "10" },
          },
        }),
      );
      const orders2 = v2.tables.Orders!;
      expect(orders2.tableUuid).toEqual(orders.tableUuid);
      expect(orders2.currentSchemaId).not.toEqual(orders.currentSchemaId);

      const live2 = yield* Iceberg.loadTable({
        namespace: "sales",
        table: orders.tableName,
      }).pipe(withCatalog);
      expect(live2.metadata.table_uuid).toEqual(orders.tableUuid);
      const fields2 = currentFields(live2.metadata);
      expect(fields2.map((f) => f.name)).toEqual([
        "id",
        "amount",
        "quantity",
        "at",
        "note",
        "coupon",
        "lines",
      ]);
      // Existing columns keep their field ids.
      for (const f of fields1) {
        expect(fields2.find((g) => g.name === f.name)?.id).toEqual(f.id);
      }
      expect(fields2.find((f) => f.name === "coupon")?.required).toBe(false);
      expect(live2.metadata.properties?.["alchemy.test.a"]).toEqual("10");
      expect(live2.metadata.properties?.["alchemy.test.b"]).toBeUndefined();

      // Re-deploying the same program is a no-op commit.
      const v2b = yield* stack.deploy(
        program(token, {
          Orders: {
            schema: OrderV2,
            partitionBy: ["day(at)"],
            properties: { "alchemy.test.a": "10" },
          },
        }),
      );
      expect(v2b.tables.Orders!.metadataLocation).toEqual(orders2.metadataLocation);

      // Destructive schema change fails the plan.
      const destructive = yield* stack
        .deploy(
          program(token, {
            Orders: { schema: OrderDestructive, partitionBy: ["day(at)"] },
          }),
        )
        .pipe(Effect.flip);
      expect(destructive).toBeInstanceOf(Basin.BasinTableChangeRejected);
      expect((destructive as Basin.BasinTableChangeRejected).reasons).toContain(
        "drops column 'amount'",
      );

      // Partition specs are immutable.
      const repartition = yield* stack
        .deploy(
          program(token, {
            Orders: { schema: OrderV2, partitionBy: ["month(at)"] },
          }),
        )
        .pipe(Effect.flip);
      expect(repartition).toBeInstanceOf(Basin.BasinTableChangeRejected);

      // The table is untouched by the rejected plans.
      const live3 = yield* Iceberg.loadTable({
        namespace: "sales",
        table: orders.tableName,
      }).pipe(withCatalog);
      expect(live3.metadata.metadata_log?.length).toEqual(live2.metadata.metadata_log?.length);
      expect(currentFields(live3.metadata).map((f) => f.name)).toContain("amount");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

// Table-level maintenance requires the job to be enabled on the catalog.
const catalogMaintenance = {
  compaction: { state: "enabled" },
  snapshotExpiration: { state: "enabled" },
} as const;

test.provider(
  "syncs per-table maintenance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const token = yield* apiToken;

      const v1 = yield* stack.deploy(
        program(
          token,
          {
            Maintained: {
              maintenance: {
                compaction: { targetSizeMb: "256" },
                snapshotExpiration: { olderThan: "3 days", retainLast: 5 },
              },
            },
          },
          catalogMaintenance,
        ),
      );
      const table = v1.tables.Maintained!;
      const key = {
        accountId: table.accountId,
        bucketName: table.bucketName,
        namespace: table.namespace,
        tableName: table.tableName,
      };
      const live1 = yield* basin.getNamespacesTablesMaintenanceConfig(key);
      expect(live1.maintenanceConfig.compaction?.state).toEqual("enabled");
      expect(live1.maintenanceConfig.compaction?.targetSizeMb).toEqual("256");
      expect(live1.maintenanceConfig.snapshotExpiration?.state).toEqual("enabled");
      expect(live1.maintenanceConfig.snapshotExpiration?.maxSnapshotAge).toEqual("3d");
      expect(live1.maintenanceConfig.snapshotExpiration?.minSnapshotsToKeep).toEqual(5);

      yield* stack.deploy(
        program(
          token,
          {
            Maintained: {
              maintenance: {
                compaction: { enabled: false },
                snapshotExpiration: { olderThan: "36 hours", retainLast: 7 },
              },
            },
          },
          catalogMaintenance,
        ),
      );
      const live2 = yield* basin.getNamespacesTablesMaintenanceConfig(key);
      expect(live2.maintenanceConfig.compaction?.state).toEqual("disabled");
      expect(live2.maintenanceConfig.snapshotExpiration?.maxSnapshotAge).toEqual("36h");
      expect(live2.maintenanceConfig.snapshotExpiration?.minSnapshotsToKeep).toEqual(7);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

test.provider(
  "delete policies: retain leaves the table, drop and purge remove it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const token = yield* apiToken;

      const deployed = yield* stack.deploy(
        program(token, {
          Retained: {},
          Dropped: { delete: "drop" },
          Purged: { delete: "purge" },
        }),
      );
      const withCatalog = iceberg(deployed.catalog, token);
      const { Retained, Dropped, Purged } = deployed.tables;
      for (const t of [Retained!, Dropped!, Purged!]) {
        expect(yield* exists("sales", t.tableName).pipe(withCatalog)).toBe(true);
      }

      // Remove the tables from the stack; keep the bucket and catalog.
      yield* stack.deploy(program(token, {}));

      // Catalog deletes are eventually consistent — poll briefly.
      const settled = (table: string, expected: boolean) =>
        exists("sales", table).pipe(
          withCatalog,
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (present) => present === expected,
            times: 10,
          }),
        );
      expect(yield* settled(Retained!.tableName, true)).toBe(true);
      expect(yield* settled(Dropped!.tableName, false)).toBe(false);
      expect(yield* settled(Purged!.tableName, false)).toBe(false);

      // Destroy disables the catalog and empties + deletes the bucket,
      // taking the retained table with it.
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);
