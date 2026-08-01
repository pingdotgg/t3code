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
import SchemasTestFunctionLive, { SchemasTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SchemasBindings");

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

describe.sequential("Schemas Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Schemas test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Schemas test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SchemasTestFunction;
        }).pipe(Effect.provide(SchemasTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Schemas test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Schemas test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 120_000,
  });

  describe("binding registration", () => {
    test.provider("all ten capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(10);
      }),
    );
  });

  describe("DescribeSchema", () => {
    test.provider(
      "reads the bound schema's document (injected registry + schema names)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/schema")) as {
            name: string;
            type: string;
            version: string;
            hasContent: boolean;
          };
          expect(response.name).toBeTruthy();
          expect(response.type).toBe("OpenApi3");
          expect(response.version).toBe("1");
          expect(response.hasContent).toBe(true);
        }),
    );
  });

  describe("ExportSchema", () => {
    test.provider(
      "surfaces the typed ForbiddenException for custom-registry schemas",
      (_stack) =>
        Effect.gen(function* () {
          // AWS only allows exporting discovered / AWS-managed schemas. The
          // call reaching the API and failing with the typed tag proves the
          // binding + IAM wiring end-to-end.
          const response = (yield* getJson("/export")) as {
            outcome: string;
            message?: string;
          };
          expect(response.outcome).toBe("forbidden");
          expect(response.message).toContain("export");
        }),
    );
  });

  describe("ListSchemaVersions", () => {
    test.provider("lists the schema's single published version", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/versions")) as {
          versions: string[];
        };
        expect(response.versions).toContain("1");
      }),
    );
  });

  describe("SearchSchemas", () => {
    test.provider(
      "finds the schema by keyword in the bound registry",
      (_stack) =>
        Effect.gen(function* () {
          // Search indexing lags schema creation by a few seconds.
          const response = yield* getJson("/search").pipe(
            Effect.map((r) => r as { names: string[] }),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r): boolean => (r.names ?? []).length > 0,
              times: 15,
            }),
          );
          expect(response.names.length).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 90_000 },
    );
  });

  describe("GetDiscoveredSchema", () => {
    test.provider("infers a schema from a sample event envelope", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* postJson("/discover")) as {
          hasContent: boolean;
        };
        expect(response.hasContent).toBe(true);
      }),
    );
  });

  describe("PutCodeBinding / DescribeCodeBinding / GetCodeBindingSource", () => {
    test.provider(
      "generates a code-binding package and downloads it",
      (_stack) =>
        Effect.gen(function* () {
          // Kick off async generation.
          const put = (yield* postJson("/codebinding")) as { status: string };
          expect(["CREATE_IN_PROGRESS", "CREATE_COMPLETE"]).toContain(
            put.status,
          );

          // Poll until generation completes (usually well under 30s).
          const status = yield* getJson("/codebinding").pipe(
            Effect.map((r) => (r as { status: string }).status),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (s): boolean => s === "CREATE_COMPLETE",
              times: 20,
            }),
          );
          expect(status).toBe("CREATE_COMPLETE");

          // The generated zip streams back as Body.
          const source = (yield* getJson("/codebinding/source")) as {
            bytes: number;
          };
          expect(source.bytes).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("StopDiscoverer / StartDiscoverer", () => {
    test.provider(
      "pauses and resumes the bound discoverer (injected discoverer id)",
      (_stack) =>
        Effect.gen(function* () {
          const stopped = (yield* postJson("/discoverer/stop")) as {
            state: string;
          };
          expect(stopped.state).toBe("STOPPED");

          const started = (yield* postJson("/discoverer/start")) as {
            state: string;
          };
          expect(started.state).toBe("STARTED");
        }),
    );
  });

  describe("consumeSchemaEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeSchemaEvents
          // must have materialized as a rule on the default bus with the
          // Lambda as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});
