import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { Region } from "@distilled.cloud/aws/Region";
import * as sts from "@distilled.cloud/aws/sts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import NeptuneBindingsTestFunctionLive, {
  NeptuneBindingsTestFunction,
} from "./fixtures/handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "NeptuneBindings");

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

describe.sequential("Neptune Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Neptune test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Neptune test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* NeptuneBindingsTestFunction;
        }).pipe(Effect.provide(NeptuneBindingsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

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
    test.provider("all capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(9);
      }),
    );
  });

  describe("DescribeDBClusters", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent cluster",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/clusters");
          expect((response as any).tag).toBe("DBClusterNotFoundFault");
        }),
    );
  });

  describe("DescribeDBInstances", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent instance",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/instances");
          expect((response as any).tag).toBe("DBInstanceNotFoundFault");
        }),
    );
  });

  describe("DescribeEvents", () => {
    test.provider("lists the account's recent Neptune events", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/events");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeDBClusterSnapshots", () => {
    test.provider("lists the account's cluster snapshots", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/snapshots");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeDBClusterEndpoints", () => {
    test.provider("lists the account's cluster endpoints", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/endpoints");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DeleteDBClusterSnapshot", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent snapshot",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/delete-snapshot-probe");
          expect((response as any).tag).toBe("DBClusterSnapshotNotFoundFault");
        }),
    );
  });

  describe("CopyDBClusterSnapshot", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent source snapshot",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/copy-snapshot-probe");
          expect((response as any).tag).toBe("DBClusterSnapshotNotFoundFault");
        }),
    );
  });

  describe("DescribePendingMaintenanceActions", () => {
    test.provider("lists the account's pending maintenance actions", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/pending-maintenance");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ApplyPendingMaintenanceAction", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent resource ARN",
      (_stack) =>
        Effect.gen(function* () {
          // Build a well-formed cluster ARN in this account/region that
          // cannot exist — the apply call must decode ResourceNotFoundFault.
          // (`Region`'s service value is itself an Effect — resolve twice.)
          const region = yield* yield* Region;
          const identity = yield* sts.getCallerIdentity({});
          const arn = `arn:aws:rds:${region}:${identity.Account}:cluster:alchemy-nonexistent-neptune-probe`;
          const response = yield* getJson(
            `/apply-probe?arn=${encodeURIComponent(arn)}`,
          );
          expect((response as any).tag).toBe("ResourceNotFoundFault");
        }),
    );
  });
});
