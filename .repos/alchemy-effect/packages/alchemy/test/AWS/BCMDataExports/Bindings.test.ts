import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import BCMDataExportsTestFunctionLive, {
  BCMDataExportsTestFunction,
  fixtureExportName,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BCMDataExportsBindings");

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

describe.sequential("BCMDataExports Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "BCMDataExports test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("BCMDataExports test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* BCMDataExportsTestFunction;
        }).pipe(Effect.provide(BCMDataExportsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `BCMDataExports test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `BCMDataExports test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 6 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(6);
      }),
    );
  });

  describe("GetExport", () => {
    test.provider("reads the fixture export's definition", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/export`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).name).toBe(fixtureExportName);
        expect((response as any).prefix).toBe("bindings");
        expect((response as any).frequency).toBe("SYNCHRONOUS");
      }),
    );
  });

  describe("ListExports", () => {
    test.provider(
      "lists the fixture export among the account's exports",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/exports`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).names).toContain(fixtureExportName);
        }),
    );
  });

  describe("ListExecutions", () => {
    test.provider(
      "lists the export's executions (fresh export: >= 0)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/executions`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect(typeof (response as any).count).toBe("number");
          expect((response as any).count).toBeGreaterThanOrEqual(0);
        }),
    );
  });

  describe("GetExecution", () => {
    test.provider(
      "surfaces a typed error for a nonexistent execution (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/execution-not-found`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain((response as any).tag);
        }),
    );
  });

  describe("GetTable", () => {
    test.provider("reads the COST_AND_USAGE_REPORT table schema", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/table`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).tableName).toBe("COST_AND_USAGE_REPORT");
        expect((response as any).columnCount).toBeGreaterThan(0);
      }),
    );
  });

  describe("ListTables", () => {
    test.provider("lists the table dictionary", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/tables`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).names).toContain("COST_AND_USAGE_REPORT");
      }),
    );
  });
});
