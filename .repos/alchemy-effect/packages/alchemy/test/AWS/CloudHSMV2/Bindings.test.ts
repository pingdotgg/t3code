import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CloudHSMV2TestFunctionLive, { CloudHSMV2TestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudHSMV2Bindings");

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

describe.sequential("CloudHSMV2 Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "CloudHSMV2 test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("CloudHSMV2 test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CloudHSMV2TestFunction;
        }).pipe(Effect.provide(CloudHSMV2TestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `CloudHSMV2 test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `CloudHSMV2 test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 10 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(10);
      }),
    );
  });

  describe("DescribeClusters", () => {
    test.provider(
      "filter on a nonexistent id returns an empty page",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/clusters");
          expect((response as any).count).toBe(0);
        }),
    );
  });

  describe("DescribeBackups", () => {
    test.provider(
      "filter on a nonexistent id returns an empty page",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/backups");
          expect((response as any).count).toBe(0);
        }),
    );
  });

  describe("DeleteBackup", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent backup",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/backup-delete");
          expect((response as any).tag).toBe(
            "CloudHsmResourceNotFoundException",
          );
        }),
    );
  });

  describe("RestoreBackup", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent backup",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/backup-restore");
          expect((response as any).tag).toBe(
            "CloudHsmResourceNotFoundException",
          );
        }),
    );
  });

  describe("ModifyBackupAttributes", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent backup",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/backup-modify");
          expect((response as any).tag).toBe(
            "CloudHsmResourceNotFoundException",
          );
        }),
    );
  });

  describe("CopyBackupToRegion", () => {
    test.provider(
      "surfaces a typed tag for a nonexistent backup (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/backup-copy");
          expect([
            "CloudHsmResourceNotFoundException",
            "CloudHsmInvalidRequestException",
          ]).toContain((response as any).tag);
        }),
    );
  });

  describe("InitializeCluster", () => {
    test.provider(
      "surfaces a typed tag for a nonexistent cluster (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/cluster-init");
          expect([
            "CloudHsmResourceNotFoundException",
            "CloudHsmInvalidRequestException",
          ]).toContain((response as any).tag);
        }),
    );
  });

  describe("GetResourcePolicy", () => {
    test.provider(
      "reaches service-side validation (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/policy-get");
          expect([
            "CloudHsmInvalidRequestException",
            "CloudHsmResourceNotFoundException",
          ]).toContain((response as any).tag);
        }),
    );
  });

  describe("PutResourcePolicy", () => {
    test.provider(
      "reaches service-side validation (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/policy-put");
          expect([
            "CloudHsmInvalidRequestException",
            "CloudHsmResourceNotFoundException",
          ]).toContain((response as any).tag);
        }),
    );
  });

  describe("DeleteResourcePolicy", () => {
    test.provider(
      "reaches service-side validation (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/policy-delete");
          expect([
            "CloudHsmInvalidRequestException",
            "CloudHsmResourceNotFoundException",
          ]).toContain((response as any).tag);
        }),
    );
  });
});
