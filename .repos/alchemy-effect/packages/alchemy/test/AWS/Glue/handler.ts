import * as Glue from "@/AWS/Glue";
import { Role } from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import { Bucket } from "@/AWS/S3";
import * as Output from "@/Output";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class GlueTestFunction extends Lambda.Function<Lambda.Function>()(
  "GlueTestFunction",
) {}

export default GlueTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(90),
  },
  Effect.gen(function* () {
    const bucket = yield* Bucket("GlueBindingsBucket", { forceDestroy: true });

    const role = yield* Role("GlueBindingsRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "glue.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole",
        "arn:aws:iam::aws:policy/AmazonS3FullAccess",
      ],
    });

    const database = yield* Glue.Database("BindingsDatabase", {});

    const table = yield* Glue.Table("BindingsEvents", {
      databaseName: database.databaseName,
      storageDescriptor: {
        location: Output.interpolate`s3://${bucket.bucketName}/events/`,
        columns: [
          { name: "id", type: "string" },
          { name: "amount", type: "double" },
        ],
      },
      partitionKeys: [{ name: "dt", type: "string" }],
      parameters: { classification: "json" },
    });

    const job = yield* Glue.Job("BindingsJob", {
      role: role.roleArn,
      command: {
        name: "pythonshell",
        pythonVersion: "3.9",
        scriptLocation: Output.interpolate`s3://${bucket.bucketName}/scripts/noop.py`,
      },
      maxCapacity: 0.0625,
      glueVersion: "3.0",
      timeout: "10 minutes",
    });

    const crawler = yield* Glue.Crawler("BindingsCrawler", {
      role: role.roleArn,
      databaseName: database.databaseName,
      targets: {
        s3Targets: [
          { path: Output.interpolate`s3://${bucket.bucketName}/crawl/` },
        ],
      },
    });

    // Event sources: the deploys prove the EventBridge rule + invoke
    // permission wiring for both Glue detail types.
    yield* Glue.consumeJobEvents({ states: ["FAILED", "TIMEOUT"] }, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(`glue job event: ${event.detail.jobName}`),
      ),
    );
    yield* Glue.consumeCrawlerEvents({ states: ["Succeeded"] }, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(`glue crawler event: ${event.detail.crawlerName}`),
      ),
    );

    // Job-scoped bindings.
    const startJobRun = yield* Glue.StartJobRun(job);
    const getJobRun = yield* Glue.GetJobRun(job);
    const getJobRuns = yield* Glue.GetJobRuns(job);
    const batchStopJobRun = yield* Glue.BatchStopJobRun(job);
    const getJobBookmark = yield* Glue.GetJobBookmark(job);
    const resetJobBookmark = yield* Glue.ResetJobBookmark(job);

    // Crawler-scoped bindings.
    const startCrawler = yield* Glue.StartCrawler(crawler);
    const stopCrawler = yield* Glue.StopCrawler(crawler);
    const getCrawler = yield* Glue.GetCrawler(crawler);

    // Catalog bindings.
    const getTables = yield* Glue.GetTables(database);
    const getTable = yield* Glue.GetTable(table);
    const getPartitions = yield* Glue.GetPartitions(table);
    const getPartition = yield* Glue.GetPartition(table);
    const createPartition = yield* Glue.CreatePartition(table);
    const batchCreatePartition = yield* Glue.BatchCreatePartition(table);
    const batchGetPartition = yield* Glue.BatchGetPartition(table);
    const updatePartition = yield* Glue.UpdatePartition(table);
    const batchUpdatePartition = yield* Glue.BatchUpdatePartition(table);
    const deletePartition = yield* Glue.DeletePartition(table);
    const batchDeletePartition = yield* Glue.BatchDeletePartition(table);

    const bound = {
      startJobRun,
      getJobRun,
      getJobRuns,
      batchStopJobRun,
      getJobBookmark,
      resetJobBookmark,
      startCrawler,
      stopCrawler,
      getCrawler,
      getTables,
      getTable,
      getPartitions,
      getPartition,
      createPartition,
      batchCreatePartition,
      batchGetPartition,
      updatePartition,
      batchUpdatePartition,
      deletePartition,
      batchDeletePartition,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        // List the job's runs (empty on a fresh job) — proves GetJobRuns.
        if (request.method === "GET" && pathname === "/job-runs") {
          const { JobRuns } = yield* getJobRuns({ MaxResults: 10 });
          return yield* HttpServerResponse.json({
            count: (JobRuns ?? []).length,
          });
        }

        // Bookmarks: a job that has never run with bookmarks enabled has no
        // entry — both operations surface the typed EntityNotFoundException.
        if (request.method === "GET" && pathname === "/job-bookmark") {
          const bookmark = yield* getJobBookmark().pipe(
            Effect.map((r) => r.JobBookmarkEntry ?? "none"),
            Effect.catchTag("EntityNotFoundException", () =>
              Effect.succeed("none" as const),
            ),
          );
          const reset = yield* resetJobBookmark().pipe(
            Effect.map(() => "reset" as const),
            Effect.catchTag("EntityNotFoundException", () =>
              Effect.succeed("none" as const),
            ),
          );
          return yield* HttpServerResponse.json({ bookmark, reset });
        }

        // Start a real (cheap pythonshell) run, read it back, then stop it —
        // proves StartJobRun + GetJobRun + BatchStopJobRun end to end.
        if (request.method === "POST" && pathname === "/job-run") {
          const { JobRunId } = yield* startJobRun({}).pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "GlueRoleNotAssumable",
              schedule: Schedule.max([
                Schedule.fixed("5 seconds"),
                Schedule.recurs(6),
              ]),
            }),
          );
          const { JobRun } = yield* getJobRun({ RunId: JobRunId! });
          const stopped = yield* batchStopJobRun({ JobRunIds: [JobRunId!] });
          return yield* HttpServerResponse.json({
            runId: JobRunId,
            state: JobRun?.JobRunState,
            stopSubmitted: (stopped.SuccessfulSubmissions ?? []).length,
            stopErrors: (stopped.Errors ?? []).length,
          });
        }

        // GetCrawler reads the crawler's live state — proves the op + grant.
        if (request.method === "GET" && pathname === "/crawler") {
          const { Crawler } = yield* getCrawler();
          return yield* HttpServerResponse.json({
            name: Crawler?.Name,
            state: Crawler?.State,
          });
        }

        // StopCrawler on an idle crawler surfaces the typed
        // CrawlerNotRunningException — proves the op + IAM grant cheaply.
        if (request.method === "POST" && pathname === "/crawler-stop") {
          const result = yield* stopCrawler().pipe(
            Effect.map(() => "stopped" as const),
            Effect.catchTag("CrawlerNotRunningException", () =>
              Effect.succeed("not-running" as const),
            ),
            Effect.catchTag("CrawlerStoppingException", () =>
              Effect.succeed("stopping" as const),
            ),
          );
          return yield* HttpServerResponse.json({ result });
        }

        // Start a crawl (empty S3 prefix) and immediately cancel it —
        // proves StartCrawler + StopCrawler live.
        if (request.method === "POST" && pathname === "/crawler-run") {
          const started = yield* startCrawler().pipe(
            Effect.map(() => "started" as const),
            Effect.catchTag("CrawlerRunningException", () =>
              Effect.succeed("already-running" as const),
            ),
          );
          const stopped = yield* stopCrawler().pipe(
            Effect.map(() => "stopped" as const),
            Effect.catchTag("CrawlerNotRunningException", () =>
              Effect.succeed("not-running" as const),
            ),
            Effect.catchTag("CrawlerStoppingException", () =>
              Effect.succeed("stopping" as const),
            ),
          );
          return yield* HttpServerResponse.json({ started, stopped });
        }

        // Catalog reads — proves GetTable + GetTables.
        if (request.method === "GET" && pathname === "/table") {
          const { Table } = yield* getTable();
          const { TableList } = yield* getTables();
          return yield* HttpServerResponse.json({
            name: Table?.Name,
            columns: (Table?.StorageDescriptor?.Columns ?? []).map(
              (c) => c.Name,
            ),
            partitionKeys: (Table?.PartitionKeys ?? []).map((k) => k.Name),
            tables: (TableList ?? []).map((t) => t.Name),
          });
        }

        // Full partition lifecycle — proves CreatePartition, GetPartition,
        // UpdatePartition, BatchCreatePartition, GetPartitions,
        // DeletePartition.
        if (request.method === "POST" && pathname === "/partitions") {
          yield* createPartition({
            PartitionInput: { Values: ["2026-01-01"] },
          }).pipe(
            Effect.catchTag("AlreadyExistsException", () => Effect.succeed({})),
          );
          const created = yield* getPartition({
            PartitionValues: ["2026-01-01"],
          });
          yield* updatePartition({
            PartitionValueList: ["2026-01-01"],
            PartitionInput: {
              Values: ["2026-01-01"],
              Parameters: { updated: "true" },
            },
          });
          const updated = yield* getPartition({
            PartitionValues: ["2026-01-01"],
          });
          const batch = yield* batchCreatePartition({
            PartitionInputList: [
              { Values: ["2026-01-02"] },
              { Values: ["2026-01-03"] },
            ],
          });
          // Bulk update the batch-created partitions' parameters.
          const batchUpdated = yield* batchUpdatePartition({
            Entries: ["2026-01-02", "2026-01-03"].map((dt) => ({
              PartitionValueList: [dt],
              PartitionInput: {
                Values: [dt],
                Parameters: { bulkUpdated: "true" },
              },
            })),
          });
          // Bulk read all three back (one miss to prove UnprocessedKeys).
          const bulk = yield* batchGetPartition({
            PartitionsToGet: [
              { Values: ["2026-01-01"] },
              { Values: ["2026-01-02"] },
              { Values: ["2026-01-03"] },
            ],
          });
          const all = yield* getPartitions();
          // Bulk delete two, single-delete the third.
          const batchDeleted = yield* batchDeletePartition({
            PartitionsToDelete: [
              { Values: ["2026-01-02"] },
              { Values: ["2026-01-03"] },
            ],
          });
          yield* deletePartition({ PartitionValues: ["2026-01-01"] }).pipe(
            Effect.catchTag("EntityNotFoundException", () => Effect.void),
          );
          const after = yield* getPartitions();
          return yield* HttpServerResponse.json({
            created: created.Partition?.Values,
            updatedParam: updated.Partition?.Parameters?.updated,
            batchErrors: (batch.Errors ?? []).length,
            batchUpdateErrors: (batchUpdated.Errors ?? []).length,
            bulkRead: (bulk.Partitions ?? []).length,
            bulkUpdatedParams: (bulk.Partitions ?? []).filter(
              (p) => p.Parameters?.bulkUpdated === "true",
            ).length,
            count: (all.Partitions ?? []).length,
            batchDeleteErrors: (batchDeleted.Errors ?? []).length,
            remaining: (after.Partitions ?? []).length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        Glue.StartJobRunHttp,
        Glue.GetJobRunHttp,
        Glue.GetJobRunsHttp,
        Glue.BatchStopJobRunHttp,
        Glue.GetJobBookmarkHttp,
        Glue.ResetJobBookmarkHttp,
        Glue.StartCrawlerHttp,
        Glue.StopCrawlerHttp,
        Glue.GetCrawlerHttp,
        Glue.GetTablesHttp,
        Glue.GetTableHttp,
        Glue.GetPartitionsHttp,
        Glue.GetPartitionHttp,
        Glue.CreatePartitionHttp,
        Glue.BatchCreatePartitionHttp,
        Glue.BatchGetPartitionHttp,
        Glue.UpdatePartitionHttp,
        Glue.BatchUpdatePartitionHttp,
        Glue.DeletePartitionHttp,
        Glue.BatchDeletePartitionHttp,
      ),
    ),
  ),
);
