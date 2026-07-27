import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ElastiCacheBindingsTestFunctionLive, {
  ElastiCacheBindingsTestFunction,
} from "./bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ElastiCacheBindings");

const NONEXISTENT_NAME = "alchemy-elasticache-nonexistent-probe";

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

const getJson = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? Effect.fail(new Error(`transient upstream ${response.status}`))
        : Effect.succeed(response),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
    Effect.flatMap((r) => r.json),
  );

describe.sequential("ElastiCache Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "ElastiCache bindings setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("ElastiCache bindings setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ElastiCacheBindingsTestFunction;
        }).pipe(Effect.provide(ElastiCacheBindingsTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* HttpClient.get(readinessUrl).pipe(
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

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all six capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(6);
      }),
    );
  });

  describe("DescribeServerlessCaches", () => {
    test.provider("lists the account's serverless caches", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/caches");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );

    test.provider("surfaces the typed not-found tag", () =>
      Effect.gen(function* () {
        const response = yield* getJson(
          `/cache-probe?name=${NONEXISTENT_NAME}`,
        );
        expect((response as any).tag).toBe("ServerlessCacheNotFoundFault");
      }),
    );
  });

  describe("DescribeServerlessCacheSnapshots", () => {
    test.provider("lists the account's snapshots", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/snapshots");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeEvents", () => {
    test.provider("lists recent serverless-cache events", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/events");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DeleteServerlessCacheSnapshot", () => {
    test.provider("surfaces the typed not-found tag", () =>
      Effect.gen(function* () {
        const response = yield* getJson(
          `/delete-probe?name=${NONEXISTENT_NAME}`,
        );
        // ServiceLinkedRoleNotFoundFault: ElastiCache validates the SLR
        // before snapshot existence in accounts that never kept a cache.
        expect([
          "ServerlessCacheSnapshotNotFoundFault",
          "ServiceLinkedRoleNotFoundFault",
        ]).toContain((response as any).tag);
      }),
    );
  });

  describe("CopyServerlessCacheSnapshot", () => {
    test.provider(
      "rejects a nonexistent source snapshot with a typed tag",
      () =>
        Effect.gen(function* () {
          const response = yield* getJson(
            `/copy-probe?name=${NONEXISTENT_NAME}`,
          );
          expect([
            "ServerlessCacheSnapshotNotFoundFault",
            "InvalidParameterValueException",
            "ServiceLinkedRoleNotFoundFault",
          ]).toContain((response as any).tag);
        }),
    );
  });

  describe("consumeCacheEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      () =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeCacheEvents must
          // have materialized as a rule on the default bus with the Lambda
          // as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });

  describe("ExportServerlessCacheSnapshot", () => {
    test.provider("rejects a nonexistent snapshot with a typed tag", () =>
      Effect.gen(function* () {
        const response = yield* getJson(
          `/export-probe?name=${NONEXISTENT_NAME}`,
        );
        expect([
          "ServerlessCacheSnapshotNotFoundFault",
          "InvalidParameterValueException",
          "ServiceLinkedRoleNotFoundFault",
        ]).toContain((response as any).tag);
      }),
    );
  });
});
