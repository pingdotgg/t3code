import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as run from "@distilled.cloud/gcp/run_v2";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import Stack from "../alchemy.run.ts";
import { SUMMARY_PREFIX, type DailySummary } from "../src/resources.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GCP.providers(),
  state: Alchemy.localState(),
});

const { getWhenReady } = Test;

// Out-of-band calls to the Google APIs resolve the same stored credentials
// the deploy uses, so the test runs against the configured profile.
const GcpHttp = Layer.mergeAll(
  GCP.GcpAuth,
  GCP.fromAuthProvider(),
  FetchHttpClient.layer,
);

// The job and the service are built from `main`, which needs a local
// image build.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

// Deploy, tests and destroy all sit behind the same Docker guard.
describe.skipIf(!dockerAvailable)("gcp-scheduled-job", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const { jobName, schedulerJobName, bucketName } = yield* stack;
      yield* destroy(Stack);

      const found = Effect.as("found" as const);
      const gone = <A, E extends { readonly _tag: string }, R>(
        self: Effect.Effect<A, E, R>,
      ) =>
        self.pipe(
          Effect.catchIf(
            (error) => error._tag === "NotFound",
            () => Effect.succeed("gone" as const),
          ),
        );
      const [job, schedulerJob, bucket] = yield* Effect.all([
        run.getProjectsLocationsJobs({ name: jobName }).pipe(found, gone),
        scheduler
          .getProjectsLocationsJobs({ name: schedulerJobName })
          .pipe(found, gone),
        storage.getBuckets({ bucket: bucketName }).pipe(found, gone),
      ]).pipe(Effect.orDie, Effect.provide(GcpHttp));
      expect({ job, schedulerJob, bucket }).toEqual({
        job: "gone",
        schedulerJob: "gone",
        bucket: "gone",
      });
    }),
    { timeout: 600_000 },
  );

  const baseUrlOf = (url: string | undefined) => {
    if (url === undefined) throw new Error("the service has no URL");
    return url.replace(/\/+$/, "");
  };

  /** Every execution the Cloud Run job has, newest first. */
  const executionsOf = (jobName: string) =>
    run
      .listProjectsLocationsJobsExecutions({ parent: jobName, pageSize: 100 })
      .pipe(
        Effect.map((page) => page.executions ?? []),
        Effect.orDie,
        Effect.provide(GcpHttp),
      );

  /** Download an object's content with the test's own credentials. */
  const download = (bucket: string, object: string) =>
    Effect.gen(function* () {
      const { accessToken } = yield* yield* Credentials;
      const res = yield* HttpClient.execute(
        HttpClientRequest.get(
          `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}`,
        ).pipe(
          HttpClientRequest.setUrlParams({ alt: "media" }),
          HttpClientRequest.bearerToken(accessToken),
        ),
      );
      expect(res.status).toBe(200);
      return yield* res.text;
    }).pipe(Effect.orDie, Effect.provide(GcpHttp));

  /** Every summary currently in the bucket. */
  const summariesIn = (bucket: string) =>
    Effect.gen(function* () {
      const { items = [] } = yield* storage
        .listObjects({ bucket, prefix: SUMMARY_PREFIX })
        .pipe(Effect.orDie, Effect.provide(GcpHttp));
      const summaries: DailySummary[] = [];
      for (const item of items) {
        if (item.name === undefined) continue;
        summaries.push(
          JSON.parse(yield* download(bucket, item.name)) as DailySummary,
        );
      }
      return summaries;
    });

  test(
    "POST /run summarizes seeded orders into the bucket",
    Effect.gen(function* () {
      const { url, project, datasetId, tableId, bucketName } = yield* stack;
      const baseUrl = baseUrlOf(url);

      // Unique region names keep the check independent of other rows.
      const tag = crypto.randomUUID().slice(0, 8);
      const east = `east-${tag}`;
      const west = `west-${tag}`;
      const occurredAt = new Date(Date.now() - 5 * 60_000).toISOString();
      const seed = [
        { region: east, amountCents: 1000 },
        { region: east, amountCents: 2500 },
        { region: east, amountCents: 499 },
        { region: west, amountCents: 1200 },
        { region: west, amountCents: 800 },
      ].map((row, i) => ({ id: `${tag}-${i}`, occurredAt, ...row }));

      // A just-created table can briefly 404 on the streaming path.
      const inserted = yield* bigquery
        .insertAllTabledata({
          projectId: project,
          datasetId,
          tableId,
          body: { rows: seed.map((json) => ({ insertId: json.id, json })) },
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "NotFound",
            schedule: Schedule.spaced("5 seconds"),
            times: 12,
          }),
          Effect.orDie,
          Effect.provide(GcpHttp),
        );
      expect(inserted.insertErrors ?? []).toEqual([]);

      yield* getWhenReady(`${baseUrl}/`);
      const started = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/run`),
      );
      expect(started.status).toBe(202);
      const { operation } = (yield* started.json) as {
        operation: string | null;
      };
      expect(operation).toContain("/operations/");

      // An execution can take ~2 minutes to start, then runs for seconds.
      const hasOurs = (summary: DailySummary) =>
        summary.regions.some((r) => r.region === east) &&
        summary.regions.some((r) => r.region === west);
      const summary = yield* summariesIn(bucketName).pipe(
        Effect.map((summaries) => summaries.find(hasOurs)),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (found) => found !== undefined,
          times: 48,
        }),
      );
      expect(summary).toBeDefined();

      const regionOf = (name: string) =>
        summary!.regions.find((r) => r.region === name);
      expect(regionOf(east)).toEqual({
        region: east,
        orders: 3,
        revenueCents: 3999,
      });
      expect(regionOf(west)).toEqual({
        region: west,
        orders: 2,
        revenueCents: 2000,
      });
      expect(summary!.orders).toBeGreaterThanOrEqual(5);
      expect(summary!.revenueCents).toBeGreaterThanOrEqual(5999);
      expect(summary!.execution).toBeTruthy();
      expect(
        new Date(summary!.to).getTime() - new Date(summary!.from).getTime(),
      ).toBe(24 * 60 * 60 * 1000);
    }),
    { timeout: 720_000 },
  );

  test(
    "the Cloud Scheduler job starts an execution through the Admin API",
    Effect.gen(function* () {
      const { jobName, schedulerJobName } = yield* stack;

      const schedulerJob = yield* scheduler
        .getProjectsLocationsJobs({ name: schedulerJobName })
        .pipe(Effect.orDie, Effect.provide(GcpHttp));
      expect(schedulerJob.schedule).toEqual("0 2 * * *");
      expect(schedulerJob.httpTarget?.uri).toEqual(
        `https://run.googleapis.com/v2/${jobName}:run`,
      );
      const job = yield* run
        .getProjectsLocationsJobs({ name: jobName })
        .pipe(Effect.orDie, Effect.provide(GcpHttp));
      expect(schedulerJob.httpTarget?.oauthToken?.serviceAccountEmail).toEqual(
        job.template?.template?.serviceAccount,
      );

      const before = (yield* executionsOf(jobName)).map((e) => e.name);

      // Don't wait for 02:00: force a run now.
      yield* scheduler
        .runProjectsLocationsJobs({ name: schedulerJobName, body: {} })
        .pipe(Effect.orDie, Effect.provide(GcpHttp));

      const fresh = yield* executionsOf(jobName).pipe(
        Effect.map((executions) =>
          executions.filter((e) => !before.includes(e.name)),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (executions) => executions.length > 0,
          times: 30,
        }),
      );
      expect(fresh.length).toBeGreaterThanOrEqual(1);

      // Cloud Scheduler records the Admin API's answer; code 0 (or unset)
      // means `jobs:run` accepted the OAuth token.
      const attempted = yield* scheduler
        .getProjectsLocationsJobs({ name: schedulerJobName })
        .pipe(
          Effect.orDie,
          Effect.provide(GcpHttp),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (j) => j.lastAttemptTime !== undefined,
            times: 24,
          }),
        );
      expect(attempted.status?.code ?? 0).toBe(0);
    }),
    { timeout: 600_000 },
  );
});
