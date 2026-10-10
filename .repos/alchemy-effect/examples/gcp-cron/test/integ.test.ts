import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import Stack from "../alchemy.run.ts";

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

// The service is built from `main`, which needs a local image build.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

interface Heartbeat {
  kind: "heartbeat" | "daily";
  jobName: string;
  scheduleTime: string;
  receivedAt: string;
  value: number;
}

const baseUrlOf = (url: string | undefined) => {
  if (url === undefined) throw new Error("the service has no URL");
  return url.replace(/\/+$/, "");
};

/** The Cloud Scheduler jobs that deliver to this service. */
const jobsFor = (project: string, location: string, baseUrl: string) =>
  scheduler
    .listProjectsLocationsJobs({
      parent: `projects/${project}/locations/${location}`,
      pageSize: 500,
    })
    .pipe(
      Effect.map(({ jobs = [] }) =>
        jobs.filter((job) =>
          job.httpTarget?.uri?.startsWith(`${baseUrl}/__alchemy/scheduler/`),
        ),
      ),
      Effect.orDie,
      Effect.provide(GcpHttp),
    );

// Deploy, tests and destroy all sit behind the same Docker guard.
describe.skipIf(!dockerAvailable)("gcp-cron", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const { url, project, location, tableName } = yield* stack;
      yield* destroy(Stack);

      expect(yield* jobsFor(project, location, baseUrlOf(url))).toEqual([]);

      // `projects/{project}/datasets/{dataset}/tables/{table}`
      const [, projectId, , datasetId, , tableId] = tableName.split("/");
      const table = yield* bigquery
        .getTables({
          projectId: projectId!,
          datasetId: datasetId!,
          tableId: tableId!,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.orDie,
          Effect.provide(GcpHttp),
        );
      expect(table).toEqual("gone");
    }),
    { timeout: 600_000 },
  );

  const heartbeatsOf = (baseUrl: string, kind: Heartbeat["kind"]) =>
    Effect.gen(function* () {
      const res = yield* HttpClient.execute(
        HttpClientRequest.get(`${baseUrl}/heartbeats?kind=${kind}&limit=50`),
      );
      expect(res.status).toBe(200);
      return ((yield* res.json) as unknown as { heartbeats: Heartbeat[] })
        .heartbeats;
    });

  test(
    "creates one Cloud Scheduler job per schedule, both OIDC-authenticated",
    Effect.gen(function* () {
      const { url, project, location } = yield* stack;
      const baseUrl = baseUrlOf(url);

      const jobs = yield* jobsFor(project, location, baseUrl);
      const byPath = Object.fromEntries(
        jobs.map((job) => [new URL(job.httpTarget!.uri!).pathname, job]),
      );
      expect(Object.keys(byPath).sort()).toEqual([
        "/__alchemy/scheduler/dailyrollup",
        "/__alchemy/scheduler/heartbeat",
      ]);
      expect(byPath["/__alchemy/scheduler/heartbeat"]!.schedule).toEqual(
        "* * * * *",
      );
      expect(byPath["/__alchemy/scheduler/dailyrollup"]!.schedule).toEqual(
        "0 0 * * *",
      );
      for (const job of jobs) {
        expect(job.httpTarget?.httpMethod).toEqual("POST");
        expect(job.httpTarget?.oidcToken?.audience).toEqual(
          job.httpTarget?.uri,
        );
      }

      // The service is public, but the schedule routes are not: a request
      // without Cloud Scheduler's token is refused.
      yield* getWhenReady(`${baseUrl}/`);
      const forged = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/__alchemy/scheduler/heartbeat`),
      );
      expect(forged.status).toBe(401);
    }),
    { timeout: 180_000 },
  );

  test(
    "a forced run of each schedule records a row in BigQuery",
    Effect.gen(function* () {
      const { url, project, location, datasetId, tableId } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      const jobs = yield* jobsFor(project, location, baseUrl);
      const jobNamed = (path: string) => {
        const job = jobs.find((candidate) =>
          candidate.httpTarget?.uri?.endsWith(path),
        );
        if (job?.name === undefined) throw new Error(`no job for ${path}`);
        return job.name;
      };
      const heartbeatJob = jobNamed("/heartbeat");
      const dailyJob = jobNamed("/dailyrollup");

      // Don't wait for the cron: run both jobs now. Each job's retry policy
      // redelivers until the fresh service and its grants are ready.
      for (const name of [heartbeatJob, dailyJob]) {
        yield* scheduler
          .runProjectsLocationsJobs({ name, body: {} })
          .pipe(Effect.orDie, Effect.provide(GcpHttp));
      }

      const shortName = (name: string) => name.split("/").pop()!;

      const heartbeat = yield* heartbeatsOf(baseUrl, "heartbeat").pipe(
        Effect.map((rows) =>
          rows.find((row) => row.jobName === shortName(heartbeatJob)),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (row) => row !== undefined,
          times: 30,
        }),
      );
      expect(heartbeat).toBeDefined();
      expect(heartbeat!.scheduleTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof heartbeat!.value).toBe("number");

      // The daily cron cannot fire during the test, so its row is the forced run.
      const daily = yield* heartbeatsOf(baseUrl, "daily").pipe(
        Effect.map((rows) =>
          rows.find((row) => row.jobName === shortName(dailyJob)),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (row) => row !== undefined,
          times: 30,
        }),
      );
      expect(daily).toBeDefined();
      expect(daily!.value).toBeGreaterThanOrEqual(0);

      // The rows are real BigQuery rows, not just what the service answers.
      const result = yield* bigquery
        .queryJobs({
          projectId: project,
          body: {
            query: `SELECT kind, COUNT(*) AS n FROM \`${project}.${datasetId}.${tableId}\` GROUP BY kind`,
            useLegacySql: false,
            location,
            timeoutMs: 30_000,
          },
        })
        .pipe(Effect.orDie, Effect.provide(GcpHttp));
      expect(result.jobComplete).toBe(true);
      const counts = Object.fromEntries(
        (result.rows ?? []).map((row) => [
          row.f?.[0]?.v as string,
          Number(row.f?.[1]?.v),
        ]),
      );
      expect(counts.heartbeat).toBeGreaterThanOrEqual(1);
      expect(counts.daily).toBeGreaterThanOrEqual(1);
    }),
    { timeout: 600_000 },
  );
});
