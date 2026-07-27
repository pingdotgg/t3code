import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import MediaConvertTestFunctionLive, {
  MediaConvertTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "MediaConvertBindings");

// A well-formed-but-nonexistent job id (MediaConvert ids look like
// `1582077664817-n4h2ck`) — drives the typed NotFoundException path.
const NONEXISTENT_JOB_ID = "0000000000000-aaaaaa";

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx (cold
// re-init, IAM propagation on the freshly attached policy that the handler's
// `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine 4xx surfaces
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
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string, body: object) =>
  send(
    HttpClientRequest.post(`${baseUrl}${path}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  ).pipe(Effect.flatMap((r) => r.json));

describe.sequential("MediaConvert Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "MediaConvert test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("MediaConvert test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* MediaConvertTestFunction;
        }).pipe(Effect.provide(MediaConvertTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds (sometimes over a
      // minute) to serve 200s.
      yield* HttpClient.get(`${baseUrl}/jobs`).pipe(
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
  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("ListJobs", () => {
    test.provider(
      "lists recent jobs from the runtime",
      () =>
        Effect.gen(function* () {
          const body = (yield* getJson("/jobs")) as { count: number };
          expect(typeof body.count).toBe("number");
        }),
      { timeout: 60_000 },
    );
  });

  describe("SearchJobs", () => {
    test.provider(
      "searches completed jobs from the runtime",
      () =>
        Effect.gen(function* () {
          const body = (yield* getJson("/search")) as { count: number };
          expect(typeof body.count).toBe("number");
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetJob", () => {
    test.provider(
      "returns the typed NotFoundException for a missing job",
      () =>
        Effect.gen(function* () {
          const body = (yield* getJson(`/job?id=${NONEXISTENT_JOB_ID}`)) as {
            status?: string;
            error?: string;
          };
          // NotFound (never Forbidden) proves the mediaconvert:GetJob grant
          // reached the API and the typed tag surfaced in the runtime.
          expect(body.error).toBe("NotFoundException");
        }),
      { timeout: 60_000 },
    );
  });

  describe("CancelJob", () => {
    test.provider(
      "returns the typed NotFoundException for a missing job",
      () =>
        Effect.gen(function* () {
          const body = (yield* postJson("/cancel", {
            id: NONEXISTENT_JOB_ID,
          })) as { cancelled: boolean; error?: string };
          expect(body.cancelled).toBe(false);
          expect(body.error).toBe("NotFoundException");
        }),
      { timeout: 60_000 },
    );
  });

  describe("Probe", () => {
    test.provider(
      "probe of a missing input fails with a typed NotFoundException",
      () =>
        Effect.gen(function* () {
          const body = (yield* postJson("/probe", {
            fileUrl: "s3://alchemy-nonexistent/in.mp4",
          })) as { probed: boolean; error?: string };
          expect(body.probed).toBe(false);
          // NotFound (never Forbidden/AccessDenied) proves the
          // mediaconvert:Probe grant reached the API; the input simply does
          // not exist.
          expect(body.error).toBe("NotFoundException");
        }),
      { timeout: 60_000 },
    );
  });

  describe("CreateJob", () => {
    test.provider(
      "submit with an unassumable role fails with a typed tag (never Forbidden)",
      () =>
        Effect.gen(function* () {
          // An in-account-format role that does not exist: the request passes
          // IAM authorization (mediaconvert:CreateJob granted + iam:PassRole
          // conditioned to the service) and fails service-side validation with
          // a typed BadRequestException — no billable transcode is started.
          const body = (yield* postJson("/submit", {
            role: "arn:aws:iam::000000000000:role/alchemy-does-not-exist",
          })) as { jobId?: string; error?: string };
          expect(body.jobId).toBeUndefined();
          expect(["BadRequestException", "AccessDeniedException"]).toContain(
            body.error,
          );
        }),
      { timeout: 60_000 },
    );
  });

  describe("StartJobsQuery + GetJobsQueryResults", () => {
    test.provider(
      "starts an async jobs query and fetches its results",
      () =>
        Effect.gen(function* () {
          const started = (yield* postJson("/jobsQuery", {})) as {
            queryId?: string;
            error?: string;
          };
          expect(started.error).toBeUndefined();
          expect(started.queryId).toBeTruthy();

          const result = yield* getJson(
            `/jobsQueryResults?id=${started.queryId}`,
          ).pipe(
            Effect.map(
              (r) => r as { status?: string; count: number; error?: string },
            ),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r): boolean =>
                r.status === "COMPLETE" ||
                r.status === "ERROR" ||
                r.error !== undefined,
              times: 20,
            }),
          );
          expect(result.error).toBeUndefined();
          expect(result.status).toBe("COMPLETE");
          expect(typeof result.count).toBe("number");
        }),
      { timeout: 120_000 },
    );
  });

  describe("consumeJobEvents", () => {
    test.provider(
      "created the EventBridge rule for MediaConvert job state changes",
      () =>
        Effect.gen(function* () {
          // The rule's physical name embeds the fixture's logical id
          // (`MediaConvertTestFunction-MediaConvertJobEvents`); find it on the
          // default bus with bounded manual pagination.
          let rule: eventbridge.Rule | undefined;
          let nextToken: string | undefined;
          for (let page = 0; page < 10 && !rule; page++) {
            const result = yield* eventbridge.listRules({
              NextToken: nextToken,
            });
            rule = (result.Rules ?? []).find((candidate) =>
              candidate.Name?.includes("MediaConvertJobEvents"),
            );
            nextToken = result.NextToken;
            if (!nextToken) break;
          }
          expect(rule).toBeDefined();
          expect(rule?.EventPattern).toContain("aws.mediaconvert");
          expect(rule?.EventPattern).toContain("MediaConvert Job State Change");
        }),
      { timeout: 60_000 },
    );
  });
});
