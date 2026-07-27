import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import OpenSearchBindingsTestFunctionLive, {
  OpenSearchBindingsTestFunction,
} from "./fixtures/handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "OpenSearchBindings");

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

describe.sequential("OpenSearch Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "OpenSearch test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("OpenSearch test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* OpenSearchBindingsTestFunction;
        }).pipe(Effect.provide(OpenSearchBindingsTestFunctionLive)),
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
        expect((response as any).bound).toHaveLength(19);
      }),
    );
  });

  describe("DescribeDomain", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/domain");
          expect((response as any).tag).toBe("ResourceNotFoundException");
        }),
    );
  });

  describe("DescribeDomains", () => {
    test.provider(
      "returns an empty status list for unknown domain names",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/domains-batch");
          expect((response as any).count).toBe(0);
        }),
    );
  });

  describe("DescribeDomainConfig", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/domain-config");
          expect((response as any).tag).toBe("ResourceNotFoundException");
        }),
    );
  });

  describe("DescribeDomainHealth", () => {
    test.provider(
      // OpenSearch reports a missing domain on this operation as the typed
      // `BaseException` ("Domain not found"), not ResourceNotFoundException.
      "surfaces the typed BaseException tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/domain-health");
          expect((response as any).tag).toBe("BaseException");
        }),
    );
  });

  describe("DescribeDomainNodes", () => {
    test.provider(
      "surfaces the typed BaseException tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/domain-nodes");
          expect((response as any).tag).toBe("BaseException");
        }),
    );
  });

  describe("DescribeDomainChangeProgress", () => {
    test.provider(
      // "No progress information found" surfaces as the typed BaseException.
      "surfaces the typed BaseException tag when no change is in flight",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/change-progress");
          expect((response as any).tag).toBe("BaseException");
        }),
    );
  });

  describe("ListDomainNames", () => {
    test.provider("lists the account's domains", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/domain-names");
        expect((response as any).count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeDomainAutoTunes", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/auto-tunes");
          expect((response as any).tag).toBe("ResourceNotFoundException");
        }),
    );
  });

  describe("ListScheduledActions", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/scheduled-actions");
          expect((response as any).tag).toBe("ResourceNotFoundException");
        }),
    );
  });

  describe("StartDomainMaintenance", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/start-maintenance-probe");
          expect((response as any).tag).toBe("ResourceNotFoundException");
        }),
    );
  });

  describe("GetDomainMaintenanceStatus", () => {
    test.provider(
      "surfaces the typed BaseException tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/maintenance-status-probe");
          expect((response as any).tag).toBe("BaseException");
        }),
    );
  });

  describe("ListDomainMaintenances", () => {
    test.provider(
      "surfaces the typed BaseException tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/maintenances");
          expect((response as any).tag).toBe("BaseException");
        }),
    );
  });

  describe("StartServiceSoftwareUpdate", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/software-update-probe");
          expect((response as any).tag).toBe("ResourceNotFoundException");
        }),
    );
  });

  describe("CancelServiceSoftwareUpdate", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/cancel-software-update-probe");
          expect((response as any).tag).toBe("ResourceNotFoundException");
        }),
    );
  });

  describe("GetUpgradeStatus", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/upgrade-status");
          expect((response as any).tag).toBe("ResourceNotFoundException");
        }),
    );
  });

  describe("GetUpgradeHistory", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent domain",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/upgrade-history");
          expect((response as any).tag).toBe("ResourceNotFoundException");
        }),
    );
  });

  describe("GetCompatibleVersions", () => {
    test.provider("maps engine versions to upgrade targets", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/compatible-versions");
        expect((response as any).count).toBeGreaterThan(0);
      }),
    );
  });

  describe("ListVersions", () => {
    test.provider("lists the supported engine versions", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/versions");
        expect((response as any).count).toBeGreaterThan(0);
      }),
    );
  });

  describe("ListInstanceTypeDetails", () => {
    test.provider("lists instance types for an engine version", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/instance-types");
        expect((response as any).count).toBeGreaterThan(0);
      }),
    );
  });
});
