import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as batch from "@distilled.cloud/aws/batch";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import BatchTestFunctionLive, { BatchTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BatchBindings");

let baseUrl: string;
const submittedJobIds = new Set<string>();

// AWS Batch auto-creates the shared, account-level `/aws/batch/job` log group
// the first time a job writes logs — it is NOT deleted with the compute
// environment / job queue / job definition. The JobDefinition provider reaps
// the family's log *streams* on delete, but the group itself lingers, and a
// stream flushed by a job finishing while the stack is mid-destroy can land
// after that reap. So on teardown: delete every stream this suite caused
// (family names are prefixed `{stackName}-`), then delete the group itself
// only when zero streams remain (nothing else is using it). The Batch service
// recreates the group on the next job, so deleting the empty group is safe.
// Idempotent: every delete tolerates ResourceNotFoundException; any other
// error is a defect so this is a valid `Effect.ensuring` finalizer.
const reapBatchJobLogGroup = Core.withProviders(
  Effect.gen(function* () {
    const logGroupName = "/aws/batch/job";
    const streams = yield* logs.describeLogStreams.pages({ logGroupName }).pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.logStreams ?? []),
      ),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
    if (streams === undefined) return; // group never created / already reaped

    const isTestOwned = (name: string | undefined): boolean =>
      name !== undefined && name.startsWith(`${sharedStack.name}-`);
    yield* Effect.forEach(
      streams.filter((s) => isTestOwned(s.logStreamName)),
      (s) =>
        logs
          .deleteLogStream({ logGroupName, logStreamName: s.logStreamName! })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          ),
      { concurrency: 4 },
    );

    // Shared group: only remove it when no foreign streams remain.
    if (streams.some((s) => !isTestOwned(s.logStreamName))) return;
    yield* logs
      .deleteLogGroup({ logGroupName })
      .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
  }).pipe(Effect.orDie),
  testOptions,
  sharedStack.name,
);

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Fresh Lambda role + Batch permissions propagate eventually — the first
// submits can 500 with AccessDenied under the handler's `Effect.orDie`.
// Retry 5xx only; a genuine 4xx fails immediately.
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

const submit = (jobName: string) =>
  Effect.gen(function* () {
    const response = yield* send(
      HttpClientRequest.post(`${baseUrl}/submit`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ jobName }),
      ),
    );
    expect(response.status).toBe(200);
    const submitted = (yield* response.json) as {
      jobId: string;
      jobName: string;
      jobArn?: string;
    };
    submittedJobIds.add(submitted.jobId);
    return submitted;
  });

/** Out-of-band job status via distilled. */
const jobStatus = (jobId: string) =>
  batch
    .describeJobs({ jobs: [jobId] })
    .pipe(Effect.map((res) => res.jobs?.[0]?.status));

const terminalJobStatuses = new Set(["SUCCEEDED", "FAILED"]);

/**
 * Release Fargate tasks before deleting the queue and compute environment.
 *
 * Several binding tests intentionally stop once a submitted job is visible;
 * leaving those jobs active makes Batch drain its managed ENIs only after
 * stack teardown has already started. Terminating every non-terminal job here
 * moves that asynchronous wait to the front of teardown, before the VPC graph
 * competes for the suite's hard timeout.
 */
const drainSubmittedJobs = Core.withProviders(
  Effect.gen(function* () {
    const jobIds = [...submittedJobIds];
    if (jobIds.length === 0) return;

    const describeSubmitted = batch
      .describeJobs({ jobs: jobIds })
      .pipe(Effect.map((response) => response.jobs ?? []));
    const jobs = yield* describeSubmitted;
    yield* Effect.forEach(
      jobs.filter((job) => !terminalJobStatuses.has(job.status ?? "")),
      (job) =>
        batch.terminateJob({
          jobId: job.jobId!,
          reason: "Batch binding test teardown",
        }),
      { concurrency: 4, discard: true },
    );

    yield* describeSubmitted.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (observed) =>
          observed.every((job) => terminalJobStatuses.has(job.status ?? "")),
        times: 10,
      }),
    );
    submittedJobIds.clear();
  }).pipe(Effect.orDie),
  testOptions,
  sharedStack.name,
);

describe("Batch Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Batch test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "Batch test setup: deploying CE -> queue -> job definition -> Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* BatchTestFunction;
        }).pipe(Effect.provide(BatchTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds (sometimes over a
      // minute) to serve 200s.
      yield* HttpClient.get(`${baseUrl}/status?jobId=readiness-probe`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(75),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(
    drainSubmittedJobs.pipe(
      Effect.andThen(sharedStack.destroy()),
      Effect.ensuring(reapBatchJobLogGroup),
    ),
    { timeout: 240_000 },
  );

  describe("SubmitJob", () => {
    test.provider(
      "submits a job that leaves the queue head (RUNNABLE or beyond)",
      () =>
        Effect.gen(function* () {
          const { jobId, jobName } = yield* submit("alchemy-e2e-echo");
          expect(jobName).toBe("alchemy-e2e-echo");
          expect(jobId).toBeTruthy();

          // Out-of-band: the job progresses past SUBMITTED/PENDING within
          // ~2 minutes on a healthy Fargate CE (bounded poll).
          const status = yield* jobStatus(jobId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (s) =>
                s === "RUNNABLE" ||
                s === "STARTING" ||
                s === "RUNNING" ||
                s === "SUCCEEDED" ||
                s === "FAILED",
              times: 24,
            }),
          );
          expect(["RUNNABLE", "STARTING", "RUNNING", "SUCCEEDED"]).toContain(
            status,
          );
        }),
      { timeout: 240_000 },
    );

    // The full RUNNABLE→STARTING→SUCCEEDED round-trip takes 1-3 minutes of
    // Fargate provisioning — gated so the default suite stays in budget.
    test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
      "submitted echo job runs to SUCCEEDED (AWS_TEST_SLOW=1)",
      () =>
        Effect.gen(function* () {
          const { jobId } = yield* submit("alchemy-e2e-echo-succeed");
          const status = yield* jobStatus(jobId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (s) => s === "SUCCEEDED" || s === "FAILED",
              times: 42,
            }),
          );
          expect(status).toBe("SUCCEEDED");
        }),
      { timeout: 480_000 },
    );
  });

  describe("DescribeJobs", () => {
    test.provider(
      "describes a submitted job from the runtime",
      () =>
        Effect.gen(function* () {
          const { jobId } = yield* submit("alchemy-e2e-describe");

          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/status?jobId=${jobId}`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            status?: string;
            jobQueue?: string;
          };
          expect(body.status).toBeTruthy();
          expect(body.jobQueue).toContain("job-queue/");
        }),
      { timeout: 120_000 },
    );
  });

  describe("CancelJob", () => {
    test.provider(
      "cancels a queued job from the runtime",
      () =>
        Effect.gen(function* () {
          const { jobId } = yield* submit("alchemy-e2e-cancel");

          // Cancel immediately — the job is still SUBMITTED/PENDING/RUNNABLE
          // (Fargate placement takes ~a minute), so cancellation applies.
          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/cancel`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                jobId,
                reason: "alchemy e2e cancel test",
              }),
            ),
          );
          expect(response.status).toBe(200);
          expect((yield* response.json) as object).toEqual({
            cancelled: true,
          });

          // Out-of-band: a cancelled-before-starting job lands in FAILED.
          // (SUCCEEDED only if the cancel raced past STARTING — accepted to
          // keep the test deterministic, but FAILED is the expected path.)
          const status = yield* jobStatus(jobId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (s): boolean => s === "FAILED" || s === "SUCCEEDED",
              times: 36,
            }),
          );
          expect(["FAILED", "SUCCEEDED"]).toContain(status);
        }),
      { timeout: 240_000 },
    );
  });

  describe("ListJobs", () => {
    test.provider(
      "lists a submitted job in the bound queue from the runtime",
      () =>
        Effect.gen(function* () {
          const { jobId } = yield* submit("alchemy-e2e-list");

          // The job moves through SUBMITTED→PENDING→RUNNABLE→STARTING→…;
          // poll the runtime ListJobs across the non-terminal statuses until
          // the submitted job shows up.
          const findJob = Effect.gen(function* () {
            for (const jobStatus of [
              "SUBMITTED",
              "PENDING",
              "RUNNABLE",
              "STARTING",
              "RUNNING",
              "SUCCEEDED",
            ]) {
              const response = yield* send(
                HttpClientRequest.get(`${baseUrl}/jobs?jobStatus=${jobStatus}`),
              );
              expect(response.status).toBe(200);
              const body = (yield* response.json) as {
                jobs: { jobId: string; jobName: string }[];
              };
              const match = body.jobs.find((job) => job.jobId === jobId);
              if (match) return match;
            }
            return undefined;
          });
          const found = yield* findJob.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (match): boolean => match !== undefined,
              times: 24,
            }),
          );
          expect(found?.jobId).toBe(jobId);
          expect(found?.jobName).toBe("alchemy-e2e-list");
        }),
      { timeout: 240_000 },
    );
  });

  describe("GetJobQueueSnapshot", () => {
    test.provider(
      "snapshots the front of the bound queue from the runtime",
      () =>
        Effect.gen(function* () {
          // The queue-ARN-scoped IAM grant + injected `jobQueue` selector:
          // a 200 with a jobs array proves the call path end to end (the
          // snapshot only surfaces RUNNABLE jobs, so membership is racy and
          // not asserted).
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/snapshot`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { jobs: unknown };
          expect(Array.isArray(body.jobs)).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("consumeJobEvents", () => {
    test.provider(
      "created the EventBridge rule for batch job state changes",
      () =>
        Effect.gen(function* () {
          // The rule's physical name embeds the fixture's logical id
          // (`BatchTestFunction-BatchJobEvents`); find it on the default bus
          // with bounded manual pagination.
          let rule: eventbridge.Rule | undefined;
          let nextToken: string | undefined;
          for (let page = 0; page < 10 && !rule; page++) {
            const result = yield* eventbridge.listRules({
              NextToken: nextToken,
            });
            rule = (result.Rules ?? []).find((candidate) =>
              candidate.Name?.includes("BatchJobEvents"),
            );
            nextToken = result.NextToken;
            if (!nextToken) break;
          }
          expect(rule).toBeDefined();
          expect(rule?.EventPattern).toContain("aws.batch");
          expect(rule?.EventPattern).toContain("Batch Job State Change");
        }),
      { timeout: 60_000 },
    );
  });

  describe("TerminateJob", () => {
    test.provider(
      "terminates a submitted job from the runtime",
      () =>
        Effect.gen(function* () {
          const { jobId } = yield* submit("alchemy-e2e-terminate");

          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/terminate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                jobId,
                reason: "alchemy e2e terminate test",
              }),
            ),
          );
          expect(response.status).toBe(200);
          expect((yield* response.json) as object).toEqual({
            terminated: true,
          });

          // Out-of-band: a job terminated before running lands in FAILED.
          const status = yield* jobStatus(jobId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (s) => s === "FAILED" || s === "SUCCEEDED",
              times: 24,
            }),
          );
          expect(status).toBe("FAILED");
        }),
      { timeout: 240_000 },
    );
  });
});
