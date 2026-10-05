import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** Dataset the Query binding reads (roles/bigquery.dataViewer on it). */
export const Analytics = GCP.BigQuery.Dataset("Analytics", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

const table = (id: string, tableId: string) =>
  Effect.gen(function* () {
    const dataset = yield* Analytics;
    return yield* GCP.BigQuery.Table(id, {
      datasetId: dataset.datasetId,
      tableId,
      schema: [{ name: "id", type: "STRING" }],
    });
  });

/** Seeded by the test; read by Query through the dataset grant. */
export const Queried = table("Queried", "queried");
/** Seeded by the test; read by ListTabledata. */
export const Listed = table("Listed", "listed");
/** Written by InsertAll. */
export const Inserted = table("Inserted", "inserted");
/** Seeded by the test; read by ReadTable. */
export const ReadRows = table("ReadRows", "read_rows");
/** Written by WriteTable. */
export const Written = table("Written", "written");
/** Written and read back by ReadWriteTable. */
export const ReadWrite = table("ReadWrite", "read_write");

/**
 * Effect-native Cloud Run service exercising every BigQuery binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class BigQueryBindingsHost extends GCP.Function<BigQueryBindingsHost>()(
  "BigQueryBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const query = yield* GCP.BigQuery.Query(Analytics);
    const insertAll = yield* GCP.BigQuery.InsertAll(Inserted);
    const listRows = yield* GCP.BigQuery.ListTabledata(Listed);
    const read = yield* GCP.BigQuery.ReadTable(ReadRows);
    const write = yield* GCP.BigQuery.WriteTable(Written);
    const readWrite = yield* GCP.BigQuery.ReadWriteTable(ReadWrite);

    return {
      fetch: serveProbes({
        query: query({ query: "SELECT id FROM queried" }),
        insertAll: insertAll({
          body: {
            rows: [{ insertId: "insert-all", json: { id: "insert-all" } }],
          },
        }),
        listTabledata: listRows({ maxResults: 10 }),
        readTable: Effect.gen(function* () {
          const page = yield* read.list({ maxResults: 10 });
          const queried = yield* read.query(
            "SELECT id FROM read_rows WHERE id = @id",
            { id: "seed" },
          );
          return { listed: page.rows, queried };
        }),
        writeTable: write.insert([{ id: "written" }], {
          insertIds: ["written"],
        }),
        readWriteTable: Effect.gen(function* () {
          yield* readWrite.insert([{ id: "read-write" }], {
            insertIds: ["read-write"],
          });
          return yield* readWrite.query("SELECT id FROM read_write");
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.BigQuery.QueryHttp),
    Effect.provide(GCP.BigQuery.InsertAllHttp),
    Effect.provide(GCP.BigQuery.ListTabledataHttp),
    Effect.provide(GCP.BigQuery.ReadTableHttp),
    Effect.provide(GCP.BigQuery.WriteTableHttp),
    Effect.provide(GCP.BigQuery.ReadWriteTableHttp),
  ),
) {}
