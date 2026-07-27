import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import DataBrewTestFunctionLive, {
  DataBrewTestFunction,
  foundation,
  SOURCE_KEY,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DataBrewBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from the shared Lambda fixture (cold re-init, IAM
// propagation on the freshly attached databrew policy surfaced as a 500 by
// the handler's `Effect.orDie`). Genuine 4xx/assertion failures return
// immediately.
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
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const getJson = (url: string) =>
  send(HttpClientRequest.get(url)).pipe(Effect.flatMap((r) => r.json));

const postJson = (url: string, body: unknown) =>
  send(
    HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
  ).pipe(Effect.flatMap((r) => r.json));

const post = (url: string) =>
  send(HttpClientRequest.post(url)).pipe(Effect.flatMap((r) => r.json));

/**
 * A route answered with a typed error tag. The tag being present proves the
 * binding produced a typed failure (untyped errors crash into a 500), and it
 * not being an authorization tag proves the IAM grant covered the call.
 */
const expectTypedNonAuthz = (body: any) => {
  expect(typeof body.errorTag).toBe("string");
  expect(body.errorTag).not.toBe("AccessDeniedException");
};

/** A route that either succeeded or failed with a typed, authorized tag. */
const expectAuthorized = (body: any) => {
  if (body.errorTag !== undefined) expectTypedNonAuthz(body);
};

class RunStillActive extends Data.TaggedError("RunStillActive") {}

/** Poll a run until it leaves STARTING/RUNNING (bounded). */
const waitForInactive = (runId: string) =>
  getJson(`${baseUrl}/run/get?id=${encodeURIComponent(runId)}`).pipe(
    Effect.flatMap((body: any) =>
      body.state === undefined ||
      body.state === "STARTING" ||
      body.state === "RUNNING"
        ? Effect.fail(new RunStillActive())
        : Effect.succeed(body.state as string),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "RunStillActive",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );

describe.sequential("DataBrew Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("DataBrew test setup: destroying previous");
      yield* sharedStack.destroy();

      // Stage 1: foundation only — the CSV must exist in the bucket before
      // the job/project are created (DataBrew validates the dataset's
      // source with the job role at Create{Profile}Job/CreateProject time).
      yield* Effect.logInfo("DataBrew test setup: deploying foundation");
      const base = yield* sharedStack.deploy(foundation);
      // `beforeAll` doesn't run inside `test.provider`'s environment, so
      // provide the AWS providers (Credentials/Region) explicitly for the
      // out-of-band distilled call.
      yield* Core.withProviders(
        s3.putObject({
          Bucket: base.bucket.bucketName,
          Key: SOURCE_KEY,
          Body: new TextEncoder().encode("id,name\n1,alice\n2,bob\n"),
          ContentType: "text/csv",
        }),
        testOptions,
        "DataBrewBindingsSeed",
      );

      // Stage 2: the full fixture (job, project, Lambda + bindings).
      yield* Effect.logInfo("DataBrew test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DataBrewTestFunction;
        }).pipe(Effect.provide(DataBrewTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/run/list`;

      yield* Effect.logInfo(
        `DataBrew test setup: probing readiness at ${readinessUrl}`,
      );
      // Ready = the function answers 200 AND the freshly attached databrew
      // policy has propagated (an AccessDeniedException errorTag means IAM
      // is still converging — keep probing).
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.flatMap((body: any) =>
          body.errorTag === undefined
            ? Effect.succeed(body)
            : Effect.fail(new Error(`IAM not propagated: ${body.errorTag}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 480_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 240_000,
  });

  describe("StartJobRun + ListJobRuns + DescribeJobRun + StopJobRun", () => {
    test.provider(
      "starts a profile run, observes it, stops it",
      (_stack) =>
        Effect.gen(function* () {
          // StartJobRun
          const started = (yield* post(`${baseUrl}/run/start`)) as any;
          expect(started.errorTag).toBeUndefined();
          expect(typeof started.runId).toBe("string");
          const runId = started.runId as string;

          // ListJobRuns sees it
          const listed = (yield* getJson(`${baseUrl}/run/list`)) as any;
          expect(listed.errorTag).toBeUndefined();
          expect(listed.runIds).toContain(runId);

          // DescribeJobRun reports a state
          const described = (yield* getJson(
            `${baseUrl}/run/get?id=${encodeURIComponent(runId)}`,
          )) as any;
          expect(described.errorTag).toBeUndefined();
          expect(typeof described.state).toBe("string");

          // StopJobRun — don't leave managed Spark capacity spinning.
          const stopped = (yield* postJson(`${baseUrl}/run/stop`, {
            id: runId,
          })) as any;
          expectAuthorized(stopped);

          // The run leaves STARTING/RUNNING (bounded poll).
          const state = yield* waitForInactive(runId);
          expect(["STOPPING", "STOPPED", "FAILED", "TIMEOUT"]).toContain(state);
        }),
      { timeout: 240_000 },
    );
  });

  describe("PublishRecipe", () => {
    test.provider("publishes a new numbered version", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* post(`${baseUrl}/recipe/publish`)) as any;
        expect(body.errorTag).toBeUndefined();
        expect(typeof body.name).toBe("string");
      }),
    );
  });

  describe("StartProjectSession + SendProjectSessionAction", () => {
    test.provider(
      "opens an interactive session and sends a preview action",
      (_stack) =>
        Effect.gen(function* () {
          const body = (yield* post(`${baseUrl}/session/run`)) as any;
          // Session provisioning is asynchronous — success and a typed
          // rejection both prove the IAM grants and the Redacted
          // ClientSessionId round-trip.
          expectAuthorized(body.started ?? body);
          if (body.started?.hasSessionId === true) {
            expect(body.started.name).toBeTruthy();
            expectAuthorized(body.action);
          }
        }),
      { timeout: 120_000 },
    );
  });
});
