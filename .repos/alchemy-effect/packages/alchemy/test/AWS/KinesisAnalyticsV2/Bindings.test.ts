import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  deleteCodeBucketIdempotent,
  provisionCodeBucket,
} from "./code-bucket.ts";
import KinesisAnalyticsV2TestFunctionLive, {
  FIXTURE_CODE_BUCKET,
  KinesisAnalyticsV2TestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "KinesisAnalyticsV2Bindings",
);

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
// Physical name of the Application the fixture creates — captured in
// beforeAll so afterAll can assert it is GONE out-of-band after destroy.
let applicationName: string | undefined;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy). Retry only
// 5xx; a genuine 4xx/assertion failure surfaces immediately.
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

describe.sequential("KinesisAnalyticsV2 Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "KinesisAnalyticsV2 test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      // Stage the code object BEFORE the Application resource deploys — the
      // service reads (and hashes) the object at create time. Direct
      // distilled calls need the AWS provider context (credentials, region)
      // that `test.provider` bodies get implicitly.
      yield* Core.withProviders(
        provisionCodeBucket(FIXTURE_CODE_BUCKET),
        testOptions,
        "KinesisAnalyticsV2Bindings",
      );

      yield* Effect.logInfo("KinesisAnalyticsV2 test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* KinesisAnalyticsV2TestFunction;
        }).pipe(Effect.provide(KinesisAnalyticsV2TestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `KinesisAnalyticsV2 test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `KinesisAnalyticsV2 test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );

      const described = (yield* getJson("/describe")) as { name?: string };
      applicationName = described.name;
      expect(applicationName).toBeTruthy();
    }),
    { timeout: 300_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      // Assert the fixture Application is GONE out-of-band — the trailing
      // destroy must leave zero orphaned cloud resources.
      if (applicationName !== undefined) {
        const gone = yield* Core.withProviders(
          analytics
            .describeApplication({ ApplicationName: applicationName })
            .pipe(Effect.flip),
          testOptions,
          "KinesisAnalyticsV2Bindings",
        );
        expect(gone._tag).toEqual("ResourceNotFoundException");
      }
    }).pipe(
      Effect.ensuring(
        Core.withProviders(
          deleteCodeBucketIdempotent(FIXTURE_CODE_BUCKET),
          testOptions,
          "KinesisAnalyticsV2Bindings",
        ),
      ),
    ),
    { timeout: 180_000 },
  );

  describe("binding registration", () => {
    test.provider("all 14 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(14);
      }),
    );
  });

  describe("DescribeApplication", () => {
    test.provider("reads the READY application detail", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/describe")) as {
          status: string;
          runtime: string;
        };
        expect(response.status).toBe("READY");
        expect(response.runtime).toBe("FLINK-1_20");
      }),
    );
  });

  describe("ListApplications", () => {
    test.provider("account list contains the bound application", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/applications")) as {
          count?: number;
          containsSelf?: boolean;
          errorTag?: string;
        };
        expect(response.errorTag).toBeUndefined();
        expect(response.containsSelf).toBe(true);
      }),
    );
  });

  describe("ListApplicationVersions", () => {
    test.provider("lists at least the initial version", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/versions")) as { count: number };
        expect(response.count).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  describe("DescribeApplicationVersion", () => {
    test.provider("reads version 1", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/version")) as {
          versionId: number;
        };
        expect(response.versionId).toBe(1);
      }),
    );
  });

  describe("ListApplicationOperations", () => {
    test.provider("lists the (possibly empty) operation history", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/operations")) as { count: number };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeApplicationOperation", () => {
    test.provider(
      "surfaces a typed tag for a nonexistent operation (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/operation")) as {
            errorTag: string;
          };
          expect([
            "ResourceNotFoundException",
            "InvalidArgumentException",
            "UnsupportedOperationException",
          ]).toContain(response.errorTag);
        }),
    );
  });

  describe("ListApplicationSnapshots", () => {
    test.provider("lists zero snapshots on the fresh application", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/snapshots")) as { count: number };
        expect(response.count).toBe(0);
      }),
    );
  });

  describe("DescribeApplicationSnapshot", () => {
    test.provider(
      "surfaces the typed not-found tag for a nonexistent snapshot",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/snapshot")) as {
            errorTag: string;
          };
          expect(response.errorTag).toBe("ResourceNotFoundException");
        }),
    );
  });

  describe("CreateApplicationSnapshot", () => {
    test.provider(
      "reaches the typed not-running rejection (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/snapshot/create")) as {
            errorTag: string;
          };
          expect([
            "InvalidApplicationConfigurationException",
            "InvalidRequestException",
            "ResourceInUseException",
            "UnsupportedOperationException",
          ]).toContain(response.errorTag);
        }),
    );
  });

  describe("DeleteApplicationSnapshot", () => {
    test.provider(
      "surfaces a typed tag for a nonexistent snapshot (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/snapshot/delete")) as {
            errorTag: string;
          };
          expect([
            "ResourceNotFoundException",
            "InvalidArgumentException",
            "InvalidRequestException",
          ]).toContain(response.errorTag);
        }),
    );
  });

  describe("CreateApplicationPresignedUrl", () => {
    test.provider(
      "mints a URL or reaches a typed rejection (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/presigned-url")) as {
            hasUrl?: boolean;
            errorTag?: string;
          };
          if (response.errorTag !== undefined) {
            expect([
              "ResourceNotFoundException",
              "ResourceInUseException",
              "InvalidArgumentException",
            ]).toContain(response.errorTag);
          } else {
            expect(response.hasUrl).toBe(true);
          }
        }),
    );
  });

  describe("RollbackApplication", () => {
    test.provider(
      "reaches the typed nothing-to-roll-back rejection (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/rollback")) as {
            errorTag: string;
          };
          expect([
            "InvalidRequestException",
            "InvalidArgumentException",
            "ResourceInUseException",
            "ConcurrentModificationException",
            "UnsupportedOperationException",
          ]).toContain(response.errorTag);
        }),
    );
  });

  describe("StopApplication", () => {
    test.provider(
      "reaches the typed not-running rejection (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/stop")) as {
            errorTag?: string;
            ok?: boolean;
          };
          if (response.errorTag !== undefined) {
            expect([
              "InvalidApplicationConfigurationException",
              "InvalidRequestException",
              "ResourceInUseException",
              "ConcurrentModificationException",
            ]).toContain(response.errorTag);
          } else {
            expect(response.ok).toBe(true);
          }
        }),
    );
  });

  // Last on purpose: if the service unexpectedly accepts the start, the
  // route force-stops immediately and no other test observes the transition.
  describe("StartApplication", () => {
    test.provider(
      "rejects a restore from a nonexistent snapshot (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/start")) as {
            errorTag?: string;
            started?: boolean;
          };
          if (response.errorTag !== undefined) {
            expect([
              "ResourceNotFoundException",
              "InvalidArgumentException",
              "InvalidApplicationConfigurationException",
              "InvalidRequestException",
              "ResourceInUseException",
            ]).toContain(response.errorTag);
          } else {
            expect(response.started).toBe(true);
          }
        }),
      { timeout: 120_000 },
    );
  });
});
