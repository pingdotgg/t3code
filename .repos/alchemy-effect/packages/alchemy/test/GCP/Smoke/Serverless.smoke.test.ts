import * as GCP from "@/GCP";
import { decodeFields } from "@/GCP/Firestore/Values.ts";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import * as eventarc from "@distilled.cloud/gcp/eventarc_v1";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import SmokeApi from "./fixtures/api.ts";
import SmokeJob from "./fixtures/job.ts";
import {
  docId,
  Jobs,
  SCHEDULE_BODY,
  Store,
  Uploads,
} from "./fixtures/serverless-resources.ts";
import SmokeWorker from "./fixtures/worker.ts";

/**
 * The GCP counterpart of the AWS serverless smoke, in ONE stack.
 *
 * Public API Function (Firestore ReadWriteDatabase on a named
 * FIRESTORE_NATIVE database, Storage ReadWriteBucket + signed URLs,
 * Pub/Sub WriteTopic, Run.RunJob) → private worker Function consuming the
 * topic over push, a Cloud Scheduler job, and Eventarc Storage finalize
 * events → an Effect-native Cloud Run Job. The test drives the story over
 * HTTP and verifies every side effect out-of-band via distilled.
 */

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "ServerlessSmoke",
  "test/GCP/Smoke/Serverless.smoke.test.ts",
);

const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

const skip = !!process.env.FAST || !dockerAvailable;

interface StackOutputs {
  url: string;
  project: string;
  apiName: string;
  apiServiceAccount: string;
  workerName: string;
  workerServiceId: string;
  workerUrl: string;
  workerServiceAccount: string;
  jobName: string;
  jobServiceAccount: string;
  databaseName: string;
  bucketName: string;
  topicName: string;
}

let outputs: StackOutputs;
let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class NotReady extends Data.TaggedError("NotReady")<{
  readonly status: number;
  readonly body: string;
}> {}

class StillExists extends Data.TaggedError("StillExists")<{
  readonly what: string;
}> {}

class DocumentMissing extends Data.TaggedError("DocumentMissing")<{
  readonly path: string;
}> {}

class ExecutionPending extends Data.TaggedError("ExecutionPending") {}

// Retry transient 5xx only (cold start, IAM propagation); 4xx and
// assertion failures surface immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
  );

// Poll a URL until it answers 200 — rides out IAM grant propagation to
// the API's runtime service account (up to a few minutes on GCP).
const awaitOk = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : response.text.pipe(
            Effect.tap((body) =>
              Effect.logInfo(
                `Serverless smoke: ${url} not ready (${response.status}: ${body.slice(0, 200)})`,
              ),
            ),
            Effect.flatMap((body) =>
              Effect.fail(new NotReady({ status: response.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "NotReady",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(72),
      ]),
    }),
  );

const documentName = (path: string) =>
  `${outputs.databaseName}/documents/${path}`;

// Out-of-band Firestore read: `undefined` when the document is missing.
const readDocument = (path: string) =>
  firestore.getProjectsDatabasesDocuments({ name: documentName(path) }).pipe(
    Effect.map((document) => decodeFields(document.fields ?? {})),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

// Bounded wait until a consumer writes `path`.
const awaitDocument = (path: string, times = 48) =>
  readDocument(path).pipe(
    Effect.flatMap((fields) =>
      fields === undefined
        ? Effect.fail(new DocumentMissing({ path }))
        : Effect.succeed(fields),
    ),
    Effect.retry({
      while: (e) => e._tag === "DocumentMissing",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(times),
      ]),
    }),
  );

// Bounded wait until an out-of-band probe reports the resource gone.
const waitUntilGone = <E, R>(
  what: string,
  probe: Effect.Effect<boolean, E, R>,
) =>
  probe.pipe(
    Effect.flatMap((gone) =>
      gone ? Effect.void : Effect.fail(new StillExists({ what })),
    ),
    Effect.retry({
      // `instanceof`, not `_tag`: the probe's error type `E` is generic.
      while: (e) => e instanceof StillExists,
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(30),
      ]),
    }),
  );

const schedulerJobFor = (workerUrl: string) =>
  scheduler
    .listProjectsLocationsJobs({
      parent: `projects/${outputs.project}/locations/us-central1`,
      pageSize: 500,
    })
    .pipe(
      Effect.map(({ jobs = [] }) =>
        jobs.find((job) =>
          job.httpTarget?.uri?.startsWith(`${workerUrl}/__alchemy/scheduler/`),
        ),
      ),
    );

const eventarcTriggerFor = (workerServiceId: string) =>
  eventarc
    .listProjectsLocationsTriggers({
      parent: `projects/${outputs.project}/locations/us-central1`,
    })
    .pipe(
      Effect.map(({ triggers = [] }) =>
        triggers.find(
          (trigger) =>
            trigger.destination?.cloudRun?.service === workerServiceId,
        ),
      ),
    );

const deployProgram = Effect.gen(function* () {
  const store = yield* Store;
  const uploads = yield* Uploads;
  const jobs = yield* Jobs;
  const api = yield* SmokeApi;
  const worker = yield* SmokeWorker;
  const job = yield* SmokeJob;
  return {
    url: api.uri,
    project: api.project,
    apiName: api.name,
    apiServiceAccount: api.serviceAccount,
    workerName: worker.name,
    workerServiceId: worker.serviceId,
    workerUrl: worker.uri,
    workerServiceAccount: worker.serviceAccount,
    jobName: job.name,
    jobServiceAccount: job.serviceAccount,
    databaseName: store.name,
    bucketName: uploads.bucketName,
    topicName: jobs.name,
  };
});

describe.sequential(
  "Serverless smoke",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:run",
      "provider:gcp:firestore",
      "provider:gcp:storage",
      "provider:gcp:pubsub",
      "provider:gcp:eventarc",
      "provider:gcp:cloudscheduler",
      "live",
    ],
  },
  () => {
    // No `beforeAll.skipIf`: a skipped run deploys nothing.
    beforeAll(
      Effect.gen(function* () {
        if (skip) return;
        yield* Effect.logInfo("Serverless smoke: destroying previous stack");
        yield* sharedStack.destroy();

        yield* Effect.logInfo("Serverless smoke: deploying stack");
        outputs = (yield* sharedStack.deploy(deployProgram)) as StackOutputs;
        baseUrl = outputs.url.replace(/\/+$/, "");

        yield* Effect.logInfo(`Serverless smoke: probing ${baseUrl}/config`);
        const config = (yield* (yield* awaitOk(`${baseUrl}/config`)).json) as {
          databaseName: string;
          bucketName: string;
          topicName: string;
          jobName: string;
        };

        // The API observes the same physical resources the stack returned.
        expect(config).toEqual({
          databaseName: outputs.databaseName,
          bucketName: outputs.bucketName,
          topicName: outputs.topicName,
          jobName: outputs.jobName,
        });

        // Firestore/Storage grants are live once /ready answers 200.
        yield* awaitOk(`${baseUrl}/ready`);
      }),
      { timeout: 1_200_000 },
    );

    afterAll.skipIf(skip)(sharedStack.destroy(), { timeout: 600_000 });

    test.provider.skipIf(skip)(
      "the API and worker are deployed with their own runtime identities",
      (_stack) =>
        Effect.gen(function* () {
          const database = yield* firestore.getProjectsDatabases({
            name: outputs.databaseName,
          });
          expect(database.type).toEqual("FIRESTORE_NATIVE");
          expect(database.name?.endsWith("/databases/(default)")).toBe(false);

          const worker = yield* cloudrun.getProjectsLocationsServices({
            name: outputs.workerName,
          });
          expect(worker.template?.serviceAccount).toEqual(
            outputs.workerServiceAccount,
          );
          expect(outputs.workerServiceAccount).not.toEqual(
            outputs.apiServiceAccount,
          );

          // The worker is private: an anonymous request is rejected.
          const anonymous = yield* HttpClient.get(outputs.workerUrl);
          expect([401, 403]).toContain(anonymous.status);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:smoke", "live"],
        timeout: 120_000,
      },
    );

    test.provider.skipIf(skip)(
      "todo CRUD through the API lands in Firestore",
      (_stack) =>
        Effect.gen(function* () {
          const text = "ship the gcp serverless smoke";
          const wrote = yield* send(
            HttpClientRequest.put(`${baseUrl}/todos/todo-1`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ text }),
            ),
          );
          expect(wrote.status).toBe(200);
          expect((yield* wrote.json) as object).toEqual({
            ok: true,
            id: "todo-1",
          });

          // Out-of-band: the document really landed in the named database.
          expect(yield* readDocument("todos/todo-1")).toEqual({
            id: "todo-1",
            text,
          });

          const read = yield* send(
            HttpClientRequest.get(`${baseUrl}/todos/todo-1`),
          );
          expect(read.status).toBe(200);
          expect((yield* read.json) as object).toEqual({
            item: { id: "todo-1", text },
          });

          const listed = yield* send(HttpClientRequest.get(`${baseUrl}/todos`));
          expect((yield* listed.json) as object).toEqual({
            todos: [{ id: "todo-1", text }],
          });

          const updated = yield* send(
            HttpClientRequest.put(`${baseUrl}/todos/todo-1`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ text: "updated" }),
            ),
          );
          expect(updated.status).toBe(200);
          expect(yield* readDocument("todos/todo-1")).toEqual({
            id: "todo-1",
            text: "updated",
          });

          const deleted = yield* send(
            HttpClientRequest.delete(`${baseUrl}/todos/todo-1`),
          );
          expect(deleted.status).toBe(204);
          expect(yield* readDocument("todos/todo-1")).toBeUndefined();

          const missing = yield* send(
            HttpClientRequest.get(`${baseUrl}/todos/todo-1`),
          );
          expect(missing.status).toBe(404);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:smoke", "live"],
        timeout: 180_000,
      },
    );

    test.provider.skipIf(skip)(
      "uploaded files read back directly and through a signed URL",
      (_stack) =>
        Effect.gen(function* () {
          const name = "hello.txt";
          const body = "uploaded through the gcp serverless smoke";

          const put = yield* send(
            HttpClientRequest.put(`${baseUrl}/files/${name}`).pipe(
              HttpClientRequest.bodyText(body, "text/plain"),
            ),
          );
          expect(put.status).toBe(200);

          // Out-of-band: the object is in the bucket.
          const object = yield* storage.getObjects({
            bucket: outputs.bucketName,
            object: name,
          });
          expect(object.contentType).toBe("text/plain");
          expect(object.size).toBe(String(body.length));

          const direct = yield* send(
            HttpClientRequest.get(`${baseUrl}/files/${name}`),
          );
          expect(direct.status).toBe(200);
          expect(yield* direct.text).toBe(body);

          // signBlob permission on the API's own account may still be
          // propagating; `send` retries the 5xx.
          const { url } = (yield* send(
            HttpClientRequest.get(`${baseUrl}/files/${name}/signed`),
          ).pipe(Effect.flatMap((r) => r.json))) as { url: string };
          expect(url).toContain(
            `https://storage.googleapis.com/${outputs.bucketName}/${name}?`,
          );
          expect(url).toContain("X-Goog-Signature=");

          // The signed URL downloads without any Google credentials.
          const signed = yield* awaitOk(url);
          expect(yield* signed.text).toBe(body);

          // Tampering with the object path invalidates the signature.
          const tampered = yield* HttpClient.get(
            url.replace(`/${name}?`, "/other.txt?"),
          );
          expect(tampered.status).toBe(403);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:smoke", "live"],
        timeout: 300_000,
      },
    );

    test.provider.skipIf(skip)(
      "an upload is delivered to the worker through Eventarc",
      (_stack) =>
        Effect.gen(function* () {
          const trigger = yield* eventarcTriggerFor(outputs.workerServiceId);
          expect(trigger?.name).toEqual(expect.any(String));

          const name = "eventarc/drop.txt";
          const put = yield* send(
            HttpClientRequest.put(
              `${baseUrl}/files/${encodeURIComponent(name)}`,
            ).pipe(HttpClientRequest.bodyText("eventarc!", "text/plain")),
          );
          expect(put.status).toBe(200);

          const marker = yield* awaitDocument(`uploads/${docId(name)}`);
          expect(marker).toMatchObject({
            type: "google.cloud.storage.object.v1.finalized",
            bucket: outputs.bucketName,
            name,
          });
        }),
      {
        tags: ["provider:gcp", "provider:gcp:smoke", "live"],
        timeout: 360_000,
      },
    );

    test.provider.skipIf(skip)(
      "a published job is processed by the worker over Pub/Sub push",
      (_stack) =>
        Effect.gen(function* () {
          const payload = "process me please";
          const published = (yield* send(
            HttpClientRequest.post(`${baseUrl}/jobs`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ payload }),
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            id: string;
            messageId: string;
          };
          expect(published.messageId).toEqual(expect.any(String));

          const result = yield* awaitDocument(`results/${published.id}`);
          expect(result).toEqual({
            id: published.id,
            payload,
            processed: payload.toUpperCase(),
            messageId: published.messageId,
          });

          // Out-of-band: the push subscription targets the worker.
          const { subscriptions = [] } =
            yield* pubsub.listProjectsTopicsSubscriptions({
              topic: outputs.topicName,
            });
          expect(subscriptions.length).toBeGreaterThan(0);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:smoke", "live"],
        timeout: 360_000,
      },
    );

    test.provider.skipIf(skip)(
      "a forced Cloud Scheduler run reaches the worker",
      (_stack) =>
        Effect.gen(function* () {
          const job = yield* schedulerJobFor(outputs.workerUrl);
          expect(job?.name).toEqual(expect.any(String));
          expect(job!.httpTarget?.oidcToken?.serviceAccountEmail).toEqual(
            outputs.workerServiceAccount,
          );

          yield* scheduler.runProjectsLocationsJobs({
            name: job!.name!,
            body: {},
          });
          const jobName = job!.name!.split("/").pop()!;
          const marker = yield* awaitDocument(`schedules/${docId(jobName)}`);
          expect(marker.jobName).toEqual(jobName);
          expect(marker.body).toEqual(SCHEDULE_BODY);
          expect(String(marker.scheduleTime)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:smoke", "live"],
        timeout: 360_000,
      },
    );

    test.provider.skipIf(skip)(
      "the API triggers a Cloud Run Job execution that records itself",
      (_stack) =>
        Effect.gen(function* () {
          const started = (yield* send(
            HttpClientRequest.post(`${baseUrl}/run-job`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            operation: string;
            execution: string | undefined;
          };
          expect(started.execution).toContain(`${outputs.jobName}/executions/`);
          const executionId = started.execution!.split("/").pop()!;

          // Cloud Run schedules a fresh execution slowly (~2 minutes).
          const execution = yield* cloudrun
            .getProjectsLocationsJobsExecutions({ name: started.execution! })
            .pipe(
              Effect.filterOrFail(
                (item) => (item.completionTime ?? "").length > 0,
                () => new ExecutionPending(),
              ),
              Effect.retry({
                while: (e) => e._tag === "ExecutionPending",
                schedule: Schedule.max([
                  Schedule.fixed("10 seconds"),
                  Schedule.recurs(36),
                ]),
              }),
            );
          expect(execution.succeededCount).toBe(1);

          const marker = yield* awaitDocument(`executions/${executionId}`, 6);
          expect(marker.execution).toEqual(executionId);
          expect(marker.ranAt).toBeInstanceOf(Date);
        }),
      {
        tags: ["provider:gcp", "provider:gcp:smoke", "live"],
        timeout: 480_000,
      },
    );

    test.provider.skipIf(skip)(
      "destroy removes the functions, job, triggers, topic, bucket, and database",
      (_stack) =>
        Effect.gen(function* () {
          const schedulerJob = yield* schedulerJobFor(outputs.workerUrl);
          const trigger = yield* eventarcTriggerFor(outputs.workerServiceId);
          expect(schedulerJob?.name).toEqual(expect.any(String));
          expect(trigger?.name).toEqual(expect.any(String));

          yield* sharedStack.destroy();

          yield* waitUntilGone(
            "api service",
            cloudrun
              .getProjectsLocationsServices({ name: outputs.apiName })
              .pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
          );
          yield* waitUntilGone(
            "worker service",
            cloudrun
              .getProjectsLocationsServices({
                name: outputs.workerName,
              })
              .pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
          );
          yield* waitUntilGone(
            "run job",
            cloudrun.getProjectsLocationsJobs({ name: outputs.jobName }).pipe(
              Effect.as(false),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            ),
          );
          yield* waitUntilGone(
            "scheduler job",
            scheduler
              .getProjectsLocationsJobs({ name: schedulerJob!.name! })
              .pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
          );
          yield* waitUntilGone(
            "eventarc trigger",
            eventarc
              .getProjectsLocationsTriggers({ name: trigger!.name! })
              .pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
          );
          yield* waitUntilGone(
            "topic",
            pubsub.getProjectsTopics({ topic: outputs.topicName }).pipe(
              Effect.as(false),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            ),
          );
          yield* waitUntilGone(
            "bucket",
            storage.getBuckets({ bucket: outputs.bucketName }).pipe(
              Effect.as(false),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            ),
          );
          yield* waitUntilGone(
            "database",
            firestore.getProjectsDatabases({ name: outputs.databaseName }).pipe(
              Effect.map((database) => database.deleteTime !== undefined),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            ),
          );
          for (const email of [
            outputs.apiServiceAccount,
            outputs.workerServiceAccount,
            outputs.jobServiceAccount,
          ]) {
            yield* waitUntilGone(
              `service account ${email}`,
              iam
                .getProjectsServiceAccounts({
                  name: `projects/${outputs.project}/serviceAccounts/${email}`,
                })
                .pipe(
                  Effect.as(false),
                  Effect.catchTag("NotFound", () => Effect.succeed(true)),
                ),
            );
          }
        }),
      {
        tags: ["provider:gcp", "provider:gcp:smoke", "live"],
        timeout: 600_000,
      },
    );
  },
);
