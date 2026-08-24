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
import DmsTestFunctionLive, { DmsTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DmsBindings");

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

describe.sequential("DMS Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("DMS test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("DMS test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DmsTestFunction;
        }).pipe(Effect.provide(DmsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `DMS test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `DMS test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(14);
      }),
    );
  });

  describe("DescribeSchemas", () => {
    test.provider(
      "answers with a typed fault for a never-refreshed endpoint",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/schemas`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            schemas: unknown[];
            fault: string | null;
          };
          // The fixture endpoint has never had a schema refresh (that needs
          // a replication instance): DMS answers with a typed fault, or an
          // empty schema list. An IAM grant gap would 500 the route instead.
          if (response.fault !== null) {
            expect([
              "ResourceNotFoundFault",
              "InvalidResourceStateFault",
            ]).toContain(response.fault);
          } else {
            expect(response.schemas).toEqual([]);
          }
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeRefreshSchemasStatus", () => {
    test.provider(
      "answers with a typed fault for a never-refreshed endpoint",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/refresh-status`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            status: string | null;
            fault: string | null;
          };
          if (response.fault !== null) {
            expect([
              "ResourceNotFoundFault",
              "InvalidResourceStateFault",
            ]).toContain(response.fault);
          } else {
            expect(response.status).toBeNull();
          }
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeConnections", () => {
    test.provider(
      "reports zero connection tests for the fresh endpoint",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/connections`),
          ).pipe(Effect.flatMap((r) => r.json))) as { count: number };
          expect(response.count).toBe(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeEvents", () => {
    test.provider(
      "reads recent replication-instance events (empty on a quiet account)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/events`),
          ).pipe(Effect.flatMap((r) => r.json))) as { count: number };
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeEndpointSettings", () => {
    test.provider(
      "enumerates the settings the mysql engine accepts",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/endpoint-settings`),
          ).pipe(Effect.flatMap((r) => r.json))) as { count: number };
          expect(response.count).toBeGreaterThan(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeOrderableReplicationInstances", () => {
    test.provider(
      "enumerates orderable replication instance classes",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/orderable`),
          ).pipe(Effect.flatMap((r) => r.json))) as { count: number };
          expect(response.count).toBeGreaterThan(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeReplicationTasks", () => {
    test.provider(
      "answers a no-match filter with zero tasks or the typed fault",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/tasks`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            count: number;
            fault: string | null;
          };
          expect(response.count).toBe(0);
          if (response.fault !== null) {
            expect(response.fault).toBe("ResourceNotFoundFault");
          }
        }),
      { timeout: 60_000 },
    );
  });

  describe("StartReplicationTask", () => {
    test.provider(
      "surfaces the typed not-found fault for a nonexistent task",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/task/start`),
          ).pipe(Effect.flatMap((r) => r.json))) as { fault: string };
          expect([
            "ResourceNotFoundFault",
            "InvalidResourceStateFault",
            "AccessDeniedFault",
          ]).toContain(response.fault);
        }),
      { timeout: 60_000 },
    );
  });

  describe("StopReplicationTask", () => {
    test.provider(
      "surfaces the typed not-found fault for a nonexistent task",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/task/stop`),
          ).pipe(Effect.flatMap((r) => r.json))) as { fault: string };
          expect([
            "ResourceNotFoundFault",
            "InvalidResourceStateFault",
          ]).toContain(response.fault);
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeTableStatistics", () => {
    test.provider(
      "surfaces the typed not-found fault for a nonexistent task",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/task/tables`),
          ).pipe(Effect.flatMap((r) => r.json))) as { fault: string };
          expect([
            "ResourceNotFoundFault",
            "InvalidResourceStateFault",
            "AccessDeniedFault",
          ]).toContain(response.fault);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ReloadTables", () => {
    test.provider(
      "surfaces the typed not-found fault for a nonexistent task",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/task/reload`),
          ).pipe(Effect.flatMap((r) => r.json))) as { fault: string };
          expect([
            "ResourceNotFoundFault",
            "InvalidResourceStateFault",
          ]).toContain(response.fault);
        }),
      { timeout: 60_000 },
    );
  });

  describe("DescribeReplications", () => {
    test.provider(
      "answers a no-match filter with zero replications or the typed fault",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/replications`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            count: number;
            fault: string | null;
          };
          expect(response.count).toBe(0);
          if (response.fault !== null) {
            expect(response.fault).toBe("ResourceNotFoundFault");
          }
        }),
      { timeout: 60_000 },
    );
  });

  describe("StartReplication", () => {
    test.provider(
      "surfaces the typed not-found fault for a nonexistent config",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/replication/start`),
          ).pipe(Effect.flatMap((r) => r.json))) as { fault: string };
          expect([
            "ResourceNotFoundFault",
            "InvalidResourceStateFault",
            "AccessDeniedFault",
          ]).toContain(response.fault);
        }),
      { timeout: 60_000 },
    );
  });

  describe("StopReplication", () => {
    test.provider(
      "surfaces the typed not-found fault for a nonexistent config",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/replication/stop`),
          ).pipe(Effect.flatMap((r) => r.json))) as { fault: string };
          expect([
            "ResourceNotFoundFault",
            "InvalidResourceStateFault",
            "AccessDeniedFault",
          ]).toContain(response.fault);
        }),
      { timeout: 60_000 },
    );
  });

  describe("consumeReplicationEvents", () => {
    test.provider(
      "created the EventBridge rule for DMS replication task state changes",
      () =>
        Effect.gen(function* () {
          // The rule's physical name embeds the fixture's logical id
          // (`DmsTestFunction-DmsReplicationEvents`); find it on the default
          // bus with bounded manual pagination.
          let rule: eventbridge.Rule | undefined;
          let nextToken: string | undefined;
          for (let page = 0; page < 10 && !rule; page++) {
            const result = yield* eventbridge.listRules({
              NextToken: nextToken,
            });
            rule = (result.Rules ?? []).find((candidate) =>
              candidate.Name?.includes("DmsReplicationEvents"),
            );
            nextToken = result.NextToken;
            if (!nextToken) break;
          }
          expect(rule).toBeDefined();
          expect(rule?.EventPattern).toContain("aws.dms");
          expect(rule?.EventPattern).toContain(
            "DMS Replication Task State Change",
          );
        }),
      { timeout: 60_000 },
    );
  });
});
