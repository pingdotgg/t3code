import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Effect from "effect/Effect";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, grantFor } from "../HttpBinding.ts";
import {
  type ListTableResult,
  QueryNotComplete,
  type ReadTableClient,
} from "./ReadTable.ts";
import { decodeRows, encodeRow, queryParameter } from "./Rows.ts";
import type { Table } from "./Table.ts";
import { InsertRowsFailed, type WriteTableClient } from "./WriteTable.ts";

// bigquery.jobs.create is only grantable on the project; data access is
// granted on the table's own IAM policy.
export const readTableIam: ReadonlyArray<BindingIam> = [
  { role: "roles/bigquery.dataViewer", on: "bigquery.table" },
  { role: "roles/bigquery.jobUser" },
];
export const writeTableIam: ReadonlyArray<BindingIam> = [
  { role: "roles/bigquery.dataEditor", on: "bigquery.table" },
];
export const readWriteTableIam: ReadonlyArray<BindingIam> = [
  { role: "roles/bigquery.dataEditor", on: "bigquery.table" },
  { role: "roles/bigquery.jobUser" },
];

export interface TableRef {
  project: string;
  datasetId: string;
  tableId: string;
  location: string | undefined;
}

// `getQueryResults` long-polls up to `timeoutMs` per call, so this bounds
// the total wait for a query job at ~2 minutes.
const QUERY_WAIT_MS = 10_000;
const QUERY_POLLS = 12;

interface QueryPage {
  jobComplete?: boolean;
  schema?: bigquery.TableSchema;
  rows?: bigquery.TableRow[];
  pageToken?: string;
}

/** Fetch every result page after `pageToken`. */
const remainingRows = <E>(
  fetchPage: (pageToken: string) => Effect.Effect<QueryPage, E>,
  pageToken: string | undefined,
): Effect.Effect<ReadonlyArray<bigquery.TableRow>, E> =>
  pageToken
    ? fetchPage(pageToken).pipe(
        Effect.flatMap((page) =>
          remainingRows(fetchPage, page.pageToken).pipe(
            Effect.map((rest) => [...(page.rows ?? []), ...rest]),
          ),
        ),
      )
    : Effect.succeed([]);

/**
 * Shared HTTP scaffolding for the BigQuery Read/Write/ReadWrite table
 * bindings: resolves the distilled operations once at Layer construction
 * and grants the level's roles at deploy time.
 *
 * NOT exported from `index.ts`.
 */
export const makeBigQueryTableHelpers = Effect.gen(function* () {
  const getTable = yield* bigquery.getTables;
  const listTabledata = yield* bigquery.listTabledata;
  const queryJobs = yield* bigquery.queryJobs;
  const getQueryResults = yield* bigquery.getQueryResultsJobs;
  const insertAll = yield* bigquery.insertAllTabledata;

  const makeRead = (table: Effect.Effect<TableRef>): ReadTableClient => ({
    list: (
      options,
    ): Effect.Effect<
      ListTableResult,
      bigquery.GetTablesError | bigquery.ListTabledataError
    > =>
      Effect.gen(function* () {
        const ref = yield* table;
        const key = {
          projectId: ref.project,
          datasetId: ref.datasetId,
          tableId: ref.tableId,
        };
        const metadata = yield* getTable({ ...key, view: "BASIC" });
        const page = yield* listTabledata({
          ...key,
          maxResults: options?.maxResults,
          pageToken: options?.pageToken,
          "formatOptions.useInt64Timestamp": true,
        });
        return {
          rows: decodeRows(metadata.schema, page.rows),
          nextPageToken: page.pageToken || undefined,
        };
      }),
    query: (
      sql,
      params,
    ): Effect.Effect<
      Record<string, unknown>[],
      | bigquery.QueryJobsError
      | bigquery.GetQueryResultsJobsError
      | QueryNotComplete
    > =>
      Effect.gen(function* () {
        const ref = yield* table;
        const first = yield* queryJobs({
          projectId: ref.project,
          body: {
            query: sql,
            useLegacySql: false,
            location: ref.location,
            defaultDataset: {
              projectId: ref.project,
              datasetId: ref.datasetId,
            },
            timeoutMs: QUERY_WAIT_MS,
            formatOptions: { useInt64Timestamp: true },
            ...(params === undefined
              ? {}
              : {
                  parameterMode: "NAMED",
                  queryParameters: Object.entries(params).map(([name, value]) =>
                    queryParameter(name, value),
                  ),
                }),
          },
        });
        const jobId = first.jobReference?.jobId;
        const location = first.jobReference?.location ?? ref.location;
        const results = (
          pageToken: string | undefined,
        ): Effect.Effect<
          bigquery.GetQueryResultsResponse,
          bigquery.GetQueryResultsJobsError | QueryNotComplete
        > =>
          jobId === undefined
            ? Effect.fail(new QueryNotComplete({ jobId }))
            : getQueryResults({
                projectId: ref.project,
                jobId,
                location,
                pageToken,
                timeoutMs: QUERY_WAIT_MS,
                "formatOptions.useInt64Timestamp": true,
              });

        const settled: Effect.Effect<
          QueryPage,
          bigquery.GetQueryResultsJobsError | QueryNotComplete
        > =
          first.jobComplete === true
            ? Effect.succeed(first)
            : results(undefined).pipe(
                Effect.repeat({
                  until: (r: bigquery.GetQueryResultsResponse) =>
                    r.jobComplete === true,
                  times: QUERY_POLLS,
                }),
              );
        const complete = yield* settled;
        if (complete.jobComplete !== true) {
          return yield* new QueryNotComplete({ jobId });
        }
        const schema = complete.schema;
        const rest: ReadonlyArray<bigquery.TableRow> = yield* remainingRows(
          results,
          complete.pageToken,
        );
        return decodeRows(schema, [...(complete.rows ?? []), ...rest]);
      }),
  });

  const makeWrite = (table: Effect.Effect<TableRef>): WriteTableClient => ({
    insert: (rows, options) =>
      Effect.gen(function* () {
        if (rows.length === 0) return;
        const ref = yield* table;
        const response = yield* insertAll({
          projectId: ref.project,
          datasetId: ref.datasetId,
          tableId: ref.tableId,
          body: {
            rows: rows.map((row, index) => ({
              json: encodeRow(row),
              insertId: options?.insertIds?.[index],
            })),
          },
        });
        const insertErrors = response.insertErrors ?? [];
        if (insertErrors.length > 0) {
          return yield* new InsertRowsFailed({
            insertErrors: insertErrors.map((item) => ({
              index: item.index,
              errors: item.errors ?? [],
            })),
          });
        }
      }),
  });

  return { makeRead, makeWrite };
});

/** Build a table binding that grants `iam` and returns `makeClient`'s client. */
export const makeBigQueryTableBinding = <Client>(options: {
  tag: string;
  iam: ReadonlyArray<BindingIam>;
  makeClient: (
    helpers: Effect.Success<typeof makeBigQueryTableHelpers>,
    table: Effect.Effect<TableRef>,
  ) => Client;
}) =>
  Effect.gen(function* () {
    const helpers = yield* makeBigQueryTableHelpers;
    return Effect.fn(function* (table: Table) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: table,
        iam: options.iam.map((iam) => grantFor(iam, table.name)),
      });
      const project = yield* table.project;
      const datasetId = yield* table.datasetId;
      const tableId = yield* table.tableId;
      const location = yield* table.location;
      const ref = Effect.all({
        project,
        datasetId,
        tableId,
        location,
      });
      return options.makeClient(helpers, ref);
    });
  });
