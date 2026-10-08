import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import BigQueryBindingsHost, {
  Analytics,
  Inserted,
  Listed,
  Queried,
  ReadRows,
  ReadWrite,
  Written,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BigQueryBindings");

let baseUrl: string;
let hostAccount: string;
let dataset: { project: string; datasetId: string; location: string };
let tables: {
  queried: string;
  listed: string;
  inserted: string;
  readRows: string;
  written: string;
  readWrite: string;
};

/** Run a GoogleSQL statement as the deploying principal. */
const runQuery = (sql: string) =>
  bigquery
    .queryJobs({
      projectId: dataset.project,
      body: {
        query: sql,
        useLegacySql: false,
        location: dataset.location,
        defaultDataset: {
          projectId: dataset.project,
          datasetId: dataset.datasetId,
        },
        timeoutMs: 60_000,
      },
    })
    .pipe(
      Effect.map((response) => {
        expect(response.jobComplete).toEqual(true);
        return (response.rows ?? []).map((row) => row.f?.[0]?.v);
      }),
    );

/**
 * Seed one row with DML: committed storage is immediately visible to
 * tabledata.list (streamed rows may still sit in the buffer).
 */
const seed = (table: string) =>
  runQuery(`INSERT INTO ${table} (id) VALUES ('seed')`);

/** Every project-level role (and its IAM Condition) `account` holds. */
const projectGrantsOf = (account: string) =>
  resourcemanager
    .getIamPolicyProjects({
      resource: `projects/${dataset.project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) =>
            (binding.members ?? []).includes(`serviceAccount:${account}`),
          )
          .map((binding) => ({
            role: binding.role,
            condition: binding.condition?.expression,
          })),
      ),
    );

/** bigquery.jobs.create is only grantable on the project. */
const JOB_USER = [{ role: "roles/bigquery.jobUser", condition: undefined }];

/** Roles `account` holds on a table's own IAM policy. */
const tableRolesOf = (table: string, account: string) =>
  bigquery
    .getIamPolicyTables({
      resource: table,
      body: { options: { requestedPolicyVersion: 1 } },
    })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) =>
            (binding.members ?? []).includes(`serviceAccount:${account}`),
          )
          .map((binding) => binding.role),
      ),
    );

const LEGACY_DATASET_ROLES: Record<string, string> = {
  READER: "roles/bigquery.dataViewer",
  WRITER: "roles/bigquery.dataEditor",
  OWNER: "roles/bigquery.dataOwner",
};

describe.skipIf(!dockerAvailable)(
  "BigQuery Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:bigquery", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* BigQueryBindingsHost;
            const analytics = yield* Analytics;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              dataset: {
                project: analytics.project,
                datasetId: analytics.datasetId,
                location: analytics.location,
              },
              tables: {
                // Not bound by any table binding: deployed for Query.
                queried: (yield* Queried).name,
                listed: (yield* Listed).name,
                inserted: (yield* Inserted).name,
                readRows: (yield* ReadRows).name,
                written: (yield* Written).name,
                readWrite: (yield* ReadWrite).name,
              },
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        dataset = out.dataset;
        tables = out.tables;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("Query", () => {
      test.provider(
        "queries the dataset as the host's service account, reading only that dataset",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("queried");
            const response = yield* expectProbe<bigquery.QueryResponse>(
              baseUrl,
              "query",
            );
            expect(response.jobComplete).toEqual(true);
            expect((response.rows ?? []).map((row) => row.f?.[0]?.v)).toEqual([
              "seed",
            ]);

            const live = yield* bigquery.getDatasets({
              projectId: dataset.project,
              datasetId: dataset.datasetId,
            });
            const datasetRoles = (live.access ?? [])
              .filter((item) => item.userByEmail === hostAccount)
              .map((item) => LEGACY_DATASET_ROLES[item.role!] ?? item.role);
            expect(datasetRoles).toEqual(["roles/bigquery.dataViewer"]);
            expect(yield* projectGrantsOf(hostAccount)).toEqual(JOB_USER);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquery", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("InsertAll", () => {
      test.provider(
        "streams a row as the host's service account, granted on the table only",
        (_stack) =>
          Effect.gen(function* () {
            const response = yield* expectProbe<{
              insertErrors?: unknown[];
            }>(baseUrl, "insertAll");
            expect(response.insertErrors ?? []).toEqual([]);
            expect(yield* runQuery("SELECT id FROM inserted")).toEqual([
              "insert-all",
            ]);
            expect(yield* tableRolesOf(tables.inserted, hostAccount)).toEqual([
              "roles/bigquery.dataEditor",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquery", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ListTabledata", () => {
      test.provider(
        "lists rows as the host's service account, granted on the table only",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("listed");
            const page = yield* expectProbe<bigquery.TableDataList>(
              baseUrl,
              "listTabledata",
            );
            expect((page.rows ?? []).map((row) => row.f?.[0]?.v)).toEqual([
              "seed",
            ]);
            expect(yield* tableRolesOf(tables.listed, hostAccount)).toEqual([
              "roles/bigquery.dataViewer",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquery", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadTable", () => {
      test.provider(
        "lists and queries the table as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed("read_rows");
            const out = yield* expectProbe<{
              listed: Array<{ id: string }>;
              queried: Array<{ id: string }>;
            }>(baseUrl, "readTable");
            expect(out.listed).toEqual([{ id: "seed" }]);
            expect(out.queried).toEqual([{ id: "seed" }]);
            expect(yield* tableRolesOf(tables.readRows, hostAccount)).toEqual([
              "roles/bigquery.dataViewer",
            ]);
            expect(yield* projectGrantsOf(hostAccount)).toEqual(JOB_USER);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquery", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("WriteTable", () => {
      test.provider(
        "inserts a row as the host's service account, granted on the table only",
        (_stack) =>
          Effect.gen(function* () {
            yield* expectProbe(baseUrl, "writeTable");
            expect(yield* runQuery("SELECT id FROM written")).toEqual([
              "written",
            ]);
            expect(yield* tableRolesOf(tables.written, hostAccount)).toEqual([
              "roles/bigquery.dataEditor",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquery", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ReadWriteTable", () => {
      test.provider(
        "inserts and reads back a row as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const rows = yield* expectProbe<Array<{ id: string }>>(
              baseUrl,
              "readWriteTable",
            );
            expect(rows).toEqual([{ id: "read-write" }]);
            expect(yield* runQuery("SELECT id FROM read_write")).toEqual([
              "read-write",
            ]);
            expect(yield* tableRolesOf(tables.readWrite, hostAccount)).toEqual([
              "roles/bigquery.dataEditor",
            ]);
            expect(yield* projectGrantsOf(hostAccount)).toEqual(JOB_USER);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:bigquery", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
