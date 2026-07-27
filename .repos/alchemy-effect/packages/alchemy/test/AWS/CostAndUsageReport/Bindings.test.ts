import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CurTestFunctionLive, { CurTestFunction, REPORT_NAME } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CurBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

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

describe.sequential("CostAndUsageReport Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("CUR test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("CUR test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CurTestFunction;
        }).pipe(Effect.provide(CurTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `CUR test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `CUR test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 180_000 });

  describe("binding registration", () => {
    test.provider("both capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toEqual([
          "describeReportDefinitions",
          "listReportTags",
        ]);
      }),
    );
  });

  describe("DescribeReportDefinitions", () => {
    test.provider(
      "lists the fixture report definition from the runtime",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/reports")) as any;
          expect(response.count).toBeGreaterThan(0);
          expect(response.names).toContain(REPORT_NAME);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListTagsForResource", () => {
    test.provider(
      "reads the fixture report's tags (proving ReportName injection + the report-scoped grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/report-tags")) as any;
          expect(response.tags.fixture).toBe("cur-bindings");
          // The provider brands the report with internal alchemy tags.
          expect(
            Object.keys(response.tags).some((k) => k.startsWith("alchemy:")),
          ).toBe(true);
        }),
      { timeout: 60_000 },
    );
  });
});
