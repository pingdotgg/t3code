import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import MemoryDBBindingsTestFunctionLive, {
  MemoryDBBindingsTestFunction,
} from "./bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "MemoryDBBindings");

const NONEXISTENT_NAME = "alchemy-memorydb-nonexistent-probe";

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

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

describe.sequential("MemoryDB Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "MemoryDB bindings setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("MemoryDB bindings setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* MemoryDBBindingsTestFunction;
        }).pipe(Effect.provide(MemoryDBBindingsTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

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
    test.provider("all eight capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(8);
      }),
    );
  });

  describe("DescribeClusters", () => {
    test.provider("lists the account's clusters", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/clusters");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );

    test.provider("surfaces the typed not-found tag", () =>
      Effect.gen(function* () {
        const response = yield* getJson(
          `/cluster-probe?name=${NONEXISTENT_NAME}`,
        );
        expect((response as any).tag).toBe("ClusterNotFoundFault");
      }),
    );
  });

  describe("DescribeSnapshots", () => {
    test.provider("lists the account's snapshots", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/snapshots");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeEvents", () => {
    test.provider("lists recent cluster events", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/events");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeServiceUpdates", () => {
    test.provider("lists the account's service updates", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/service-updates");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeEngineVersions", () => {
    test.provider("lists supported valkey engine versions", () =>
      Effect.gen(function* () {
        const response = yield* getJson("/engine-versions");
        expect((response as any).count).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  describe("BatchUpdateCluster", () => {
    test.provider("rejects a nonexistent cluster with a typed outcome", () =>
      Effect.gen(function* () {
        const response = yield* getJson(
          `/batch-probe?name=${NONEXISTENT_NAME}`,
        );
        const { unprocessed, tag } = response as {
          unprocessed: number;
          tag: string;
        };
        // Either the cluster comes back unprocessed or the call is rejected
        // with a typed tag — an IAM gap would have 500'd the route instead.
        // Observed live: ServiceUpdateNotFoundFault ("Service Update ...
        // not found").
        expect(
          unprocessed >= 1 ||
            [
              "ServiceUpdateNotFoundFault",
              "InvalidParameterCombinationException",
              "InvalidParameterValueException",
            ].includes(tag),
        ).toBe(true);
      }),
    );
  });

  describe("DeleteSnapshot", () => {
    test.provider("surfaces the typed not-found tag", () =>
      Effect.gen(function* () {
        const response = yield* getJson(
          `/delete-probe?name=${NONEXISTENT_NAME}`,
        );
        // ServiceLinkedRoleNotFoundFault: MemoryDB validates the SLR before
        // snapshot existence in accounts that never kept a cluster.
        expect([
          "SnapshotNotFoundFault",
          "ServiceLinkedRoleNotFoundFault",
        ]).toContain((response as any).tag);
      }),
    );
  });

  describe("CopySnapshot", () => {
    test.provider(
      "rejects a nonexistent source snapshot with a typed tag",
      () =>
        Effect.gen(function* () {
          const response = yield* getJson(
            `/copy-probe?name=${NONEXISTENT_NAME}`,
          );
          expect([
            "SnapshotNotFoundFault",
            "InvalidParameterValueException",
            "ServiceLinkedRoleNotFoundFault",
          ]).toContain((response as any).tag);
        }),
    );
  });
});
