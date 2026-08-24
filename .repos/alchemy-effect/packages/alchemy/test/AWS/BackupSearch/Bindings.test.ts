import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as backupsearch from "@distilled.cloud/aws/backupsearch";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import BackupSearchTestFunctionLive, {
  BackupSearchTestFunction,
  FIXTURE_SEARCH_JOB_NAME,
} from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BackupSearchBindings");

// Every deploy starts a real search job, and search jobs CANNOT be deleted —
// terminal records are retained server-side for ~7 days. The suite is gated
// behind AWS_TEST_BACKUP_SEARCH=1 alongside the SearchJob lifecycle test so
// routine CI runs don't accumulate un-deletable job records.
const gated = !process.env.AWS_TEST_BACKUP_SEARCH;

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

// Retry transient 5xx from cold re-inits; genuine 4xx fails immediately.
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

// Search jobs cannot be deleted; "orphan-free" means never leaving one
// RUNNING. Stop any RUNNING job with the fixture's deterministic name
// (crash-safe — covers a run that died before the afterAll destroy).
const stopLeakedSearchJobs = Effect.gen(function* () {
  const page = yield* backupsearch.listSearchJobs({
    ByStatus: "RUNNING",
    MaxResults: 25,
  });
  yield* Effect.forEach(
    (page.SearchJobs ?? []).filter(
      (job) => job.Name === FIXTURE_SEARCH_JOB_NAME,
    ),
    (job) =>
      backupsearch
        .stopSearchJob({ SearchJobIdentifier: job.SearchJobIdentifier! })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          Effect.catchTag("ConflictException", () => Effect.void),
        ),
  );
}).pipe(Effect.orDie);

describe.skipIf(gated)("BackupSearch Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Pre-clean: the scratch state is in-memory, so the destroy above
      // cannot see a job leaked by a crashed prior run.
      yield* Core.withProviders(
        stopLeakedSearchJobs,
        testOptions,
        sharedStack.name,
      );

      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* BackupSearchTestFunction;
        }).pipe(Effect.provide(BackupSearchTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(
    sharedStack
      .destroy()
      .pipe(
        Effect.ensuring(
          Core.withProviders(
            stopLeakedSearchJobs,
            testOptions,
            sharedStack.name,
          ),
        ),
      ),
    { timeout: 120_000 },
  );

  describe("binding registration", () => {
    test.provider("all capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toEqual([
          "listSearchJobResults",
          "listSearchJobBackups",
          "getSearchJob",
        ]);
      }),
    );
  });

  describe("GetSearchJob", () => {
    test.provider("reads the fixture search job's status", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/job`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).name).toBe(FIXTURE_SEARCH_JOB_NAME);
        expect([
          "RUNNING",
          "COMPLETED",
          "STOPPING",
          "STOPPED",
          "FAILED",
        ]).toContain((response as any).status);
      }),
    );
  });

  describe("ListSearchJobResults", () => {
    test.provider("lists the fixture search job's results", (_stack) =>
      Effect.gen(function* () {
        // The fixture job matches nothing on purpose — assert the call
        // round-trips (IAM grant + identifier injection) with a well-formed
        // page rather than any particular hit count.
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/results`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("ListSearchJobBackups", () => {
    test.provider(
      "lists the recovery points the search job covered",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/backups`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect(typeof (response as any).count).toBe("number");
          expect(Array.isArray((response as any).statuses)).toBe(true);
        }),
    );
  });
});
