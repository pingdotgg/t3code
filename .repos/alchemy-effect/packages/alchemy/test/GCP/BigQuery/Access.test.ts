import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/** JSON-safe view of a decoded row so Action output round-trips state. */
const describeRow = (
  row: Record<string, unknown>,
): Record<string, unknown> => ({
  ...row,
  at: row.at instanceof Date ? row.at.toISOString() : row.at,
  payload: row.payload instanceof Uint8Array ? [...row.payload] : row.payload,
});

test.provider(
  "ReadTable, WriteTable, and ReadWriteTable clients",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.BigQuery.Dataset("Access", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const table = yield* GCP.BigQuery.Table("Scores", {
            datasetId: dataset.datasetId,
            schema: [
              { name: "id", type: "STRING", mode: "REQUIRED" },
              { name: "score", type: "INTEGER" },
              { name: "ratio", type: "FLOAT" },
              { name: "ok", type: "BOOLEAN" },
              { name: "at", type: "TIMESTAMP" },
              { name: "payload", type: "BYTES" },
              { name: "tags", type: "STRING", mode: "REPEATED" },
              {
                name: "meta",
                type: "RECORD",
                fields: [{ name: "k", type: "STRING" }],
              },
            ],
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              const tableId = yield* table.tableId;
              const reader = yield* GCP.BigQuery.ReadTable(table);
              const writer = yield* GCP.BigQuery.WriteTable(table);
              const both = yield* GCP.BigQuery.ReadWriteTable(table);
              return Effect.fn(function* () {
                yield* writer.insert(
                  [
                    {
                      id: "a",
                      score: 5,
                      ratio: 0.5,
                      ok: true,
                      at: new Date("2026-01-02T03:04:05.678Z"),
                      payload: new Uint8Array([0, 1, 255]),
                      tags: ["x", "y"],
                      meta: { k: "v" },
                    },
                    { id: "b", score: 20, tags: [] },
                  ],
                  { insertIds: ["a", "b"] },
                );
                yield* both.insert([{ id: "c", score: 30, ok: false }]);
                const rejected = yield* writer
                  .insert([{ id: "bad", score: "not-a-number" }])
                  .pipe(
                    Effect.map(() => "inserted"),
                    Effect.catchTag("GCP.BigQuery.InsertRowsFailed", (error) =>
                      Effect.succeed(
                        `${error.insertErrors.length}:${error.insertErrors[0]?.index}`,
                      ),
                    ),
                  );

                // Streaming-buffer rows become readable shortly after insert.
                const listed = yield* reader.list().pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("2 seconds"),
                    until: (page) => page.rows.length >= 3,
                    times: 30,
                  }),
                );
                const page = yield* both.list({ maxResults: 1 });

                const sql = `SELECT id, score FROM \`${yield* tableId}\` WHERE score >= @min AND id != @skip ORDER BY id`;
                const queried = yield* reader
                  .query(sql, { min: 10, skip: "none" })
                  .pipe(
                    Effect.repeat({
                      schedule: Schedule.spaced("2 seconds"),
                      until: (rows) => rows.length >= 2,
                      times: 30,
                    }),
                  );
                const typed = yield* both.query(
                  "SELECT @n AS n, @f AS f, @b AS b, @s AS s, CURRENT_TIMESTAMP() IS NOT NULL AS now",
                  { n: 7, f: 1.5, b: true, s: "str" },
                );

                return {
                  rejected,
                  rows: listed.rows
                    .map(describeRow)
                    .sort((l, r) => String(l.id).localeCompare(String(r.id))),
                  page: page.rows.length,
                  hasNextPage: page.nextPageToken !== undefined,
                  queried,
                  typed,
                };
              });
            }).pipe(
              Effect.provide(GCP.BigQuery.ReadTableHttp),
              Effect.provide(GCP.BigQuery.WriteTableHttp),
              Effect.provide(GCP.BigQuery.ReadWriteTableHttp),
            ),
          );
          return { probe: yield* Probe({}) };
        }),
      );

      expect(out.probe).toEqual({
        rejected: "1:0",
        rows: [
          {
            id: "a",
            score: 5,
            ratio: 0.5,
            ok: true,
            at: "2026-01-02T03:04:05.678Z",
            payload: [0, 1, 255],
            tags: ["x", "y"],
            meta: { k: "v" },
          },
          {
            id: "b",
            score: 20,
            ratio: null,
            ok: null,
            at: null,
            payload: null,
            tags: [],
            meta: null,
          },
          {
            id: "c",
            score: 30,
            ratio: null,
            ok: false,
            at: null,
            payload: null,
            tags: [],
            meta: null,
          },
        ],
        page: 1,
        hasNextPage: true,
        queried: [
          { id: "b", score: 20 },
          { id: "c", score: 30 },
        ],
        typed: [{ n: 7, f: 1.5, b: true, s: "str", now: true }],
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigquery", "live"], timeout: 240_000 },
);
