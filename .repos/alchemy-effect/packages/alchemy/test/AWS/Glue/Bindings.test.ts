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
import GlueTestFunctionLive, { GlueTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "GlueBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
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

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("Glue Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Glue test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Glue test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* GlueTestFunction;
        }).pipe(Effect.provide(GlueTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Glue test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Glue test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );

      // Glue's authorization layer caches IAM evaluations: a freshly created
      // role + inline policy is denied (`AccessDeniedException`) by the Glue
      // endpoint for ~3–5 minutes after `PutRolePolicy`, even though the
      // policy is attached (verified via CloudTrail: policy attached
      // 17:10:47Z, every glue:* call denied until exactly 17:15:50Z). Gate
      // the suite on the first job-scoped call succeeding so the tests
      // measure binding behavior, not IAM propagation.
      yield* Effect.logInfo("Glue test setup: waiting for IAM propagation");
      yield* HttpClient.get(`${baseUrl}/job-runs`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(
                new Error(`Glue IAM not propagated: ${response.status}`),
              ),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("5 seconds"),
            Schedule.recurs(84),
          ]),
        }),
      );
    }),
    { timeout: 900_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 300_000,
  });

  describe("binding registration", () => {
    test.provider("all twenty capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(20);
      }),
    );
  });

  describe("GetJobRuns", () => {
    test.provider("lists the job's runs (injected job name)", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/job-runs")) as { count: number };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("GetJobBookmark / ResetJobBookmark", () => {
    test.provider("both surface the typed missing-bookmark error", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/job-bookmark")) as {
          bookmark: string;
          reset: string;
        };
        expect(response.bookmark).toBe("none");
        expect(response.reset).toBe("none");
      }),
    );
  });

  describe("StartJobRun / GetJobRun / BatchStopJobRun", () => {
    test.provider(
      "starts, reads, and stops a live run",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/job-run")) as {
            runId: string;
            state: string;
            stopSubmitted: number;
            stopErrors: number;
          };
          expect(response.runId).toMatch(/^jr_/);
          expect(response.state).toBeTruthy();
          expect(response.stopSubmitted + response.stopErrors).toBe(1);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetCrawler", () => {
    test.provider("reads the bound crawler's live state", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/crawler")) as {
          name: string;
          state: string;
        };
        expect(response.name).toBeTruthy();
        expect(["READY", "RUNNING", "STOPPING"]).toContain(response.state);
      }),
    );
  });

  describe("StartCrawler / StopCrawler", () => {
    test.provider("stop on an idle crawler is the typed not-running", () =>
      Effect.gen(function* () {
        const response = (yield* postJson("/crawler-stop")) as {
          result: string;
        };
        expect(response.result).toBe("not-running");
      }),
    );

    test.provider(
      "starts a crawl and cancels it",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/crawler-run")) as {
            started: string;
            stopped: string;
          };
          expect(["started", "already-running"]).toContain(response.started);
          expect(["stopped", "stopping", "not-running"]).toContain(
            response.stopped,
          );
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetTable / GetTables", () => {
    test.provider(
      "reads the bound table's schema and the database's tables",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/table")) as {
            name: string;
            columns: string[];
            partitionKeys: string[];
            tables: string[];
          };
          expect(response.columns).toEqual(["id", "amount"]);
          expect(response.partitionKeys).toEqual(["dt"]);
          expect(response.tables).toContain(response.name);
        }),
    );
  });

  describe("Partitions", () => {
    test.provider(
      "create, get, update, batch-create/update/get, list, batch-delete",
      () =>
        Effect.gen(function* () {
          const response = (yield* postJson("/partitions")) as {
            created: string[];
            updatedParam: string;
            batchErrors: number;
            batchUpdateErrors: number;
            bulkRead: number;
            bulkUpdatedParams: number;
            count: number;
            batchDeleteErrors: number;
            remaining: number;
          };
          expect(response.created).toEqual(["2026-01-01"]);
          expect(response.updatedParam).toBe("true");
          expect(response.batchErrors).toBe(0);
          expect(response.batchUpdateErrors).toBe(0);
          expect(response.bulkRead).toBe(3);
          expect(response.bulkUpdatedParams).toBe(2);
          expect(response.count).toBe(3);
          expect(response.batchDeleteErrors).toBe(0);
          expect(response.remaining).toBe(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("consumeJobEvents / consumeCrawlerEvents", () => {
    test.provider(
      "the deploy created EventBridge rules targeting the function",
      () =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's two consume* calls must
          // have materialized as rules on the default bus with the Lambda as
          // target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(2);
        }),
    );
  });
});
