import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import RedshiftBindingsTestFunctionLive, {
  RedshiftBindingsTestFunction,
} from "./fixtures/bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RedshiftBindings");

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

describe.sequential("Redshift Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Redshift bindings setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Redshift bindings setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* RedshiftBindingsTestFunction;
        }).pipe(Effect.provide(RedshiftBindingsTestFunctionLive)),
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
        expect((response as any).bound).toHaveLength(5);
      }),
    );
  });

  describe("DescribeClusters", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent cluster",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/clusters");
          expect((response as any).tag).toBe("ClusterNotFoundFault");
        }),
    );
  });

  describe("DescribeClusterSnapshots", () => {
    test.provider("lists the account's manual snapshots", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/snapshots");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeEvents", () => {
    test.provider("lists the account's recent Redshift events", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/events");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DeleteClusterSnapshot", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent snapshot",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/delete-snapshot-probe");
          expect((response as any).tag).toBe("ClusterSnapshotNotFoundFault");
        }),
    );
  });

  describe("CopyClusterSnapshot", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent source snapshot",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/copy-snapshot-probe");
          expect((response as any).tag).toBe("ClusterSnapshotNotFoundFault");
        }),
    );
  });
});
