import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as sts from "@distilled.cloud/aws/sts";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import BdaTestFunctionLive, { BdaTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BdaBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let profileArn: string | undefined;

// The cross-region data automation profile ARN is account + geography
// scoped. Credentials are only provided inside `test.provider` contexts, so
// this is computed lazily by the first test that needs it.
const getProfileArn = Effect.gen(function* () {
  if (profileArn !== undefined) return profileArn;
  const { Account } = yield* sts.getCallerIdentity({});
  const region = yield* Effect.sync(
    () => process.env.AWS_REGION ?? "us-west-2",
  );
  const geo = region.startsWith("eu-")
    ? "eu"
    : region.startsWith("ap-")
      ? "apac"
      : "us";
  profileArn = `arn:aws:bedrock:${region}:${Account}:data-automation-profile/${geo}.data-automation-v1`;
  return profileArn;
});

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policies that the
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

describe.sequential("BedrockDataAutomation Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("BDA test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("BDA test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* BdaTestFunction;
        }).pipe(Effect.provide(BdaTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `BDA test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `BDA test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 180_000 });

  describe("binding registration", () => {
    test.provider("all 14 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(14);
      }),
    );
  });

  describe("InvokeDataAutomationAsync + GetDataAutomationStatus", () => {
    test.provider(
      "submits an async job against the bound project and polls its status",
      (_stack) =>
        Effect.gen(function* () {
          const arn = yield* getProfileArn;
          const invoked = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/invoke-async?profileArn=${encodeURIComponent(arn)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            invocationArn?: string;
            error?: string;
            message?: string;
          };
          // Proves project injection + bedrock:InvokeDataAutomationAsync +
          // the caller-permission S3 grants end-to-end. On failure the
          // fixture reports the typed tag + message here.
          expect(
            invoked.error === undefined
              ? "none"
              : `${invoked.error}: ${invoked.message}`,
          ).toBe("none");
          const invocationArn = invoked.invocationArn;
          expect(invocationArn).toContain(":data-automation-invocation/");
          if (invocationArn === undefined) {
            // Unreachable — the expect above throws on undefined; this
            // narrows the type for the status poll below.
            return yield* Effect.die(new Error("invocationArn missing"));
          }

          // Immediate status poll — the job settles asynchronously, so any
          // lifecycle status proves bedrock:GetDataAutomationStatus.
          const status = (yield* send(
            HttpClientRequest.get(
              `${baseUrl}/status?invocationArn=${encodeURIComponent(invocationArn)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as { status: string };
          expect([
            "Created",
            "InProgress",
            "Success",
            "ServiceError",
            "ClientError",
          ]).toContain(status.status);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Library ingestion jobs + entities", () => {
    test.provider(
      "starts an inline ingestion job, polls it, and lists jobs + entities",
      (_stack) =>
        Effect.gen(function* () {
          // InvokeDataAutomationLibraryIngestionJob — inline vocabulary
          // upsert against the bound library.
          const ingested = (yield* send(
            HttpClientRequest.post(`${baseUrl}/library-ingest`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            jobArn?: string;
            error?: string;
            message?: string;
          };
          expect(
            ingested.error === undefined
              ? "none"
              : `${ingested.error}: ${ingested.message}`,
          ).toBe("none");
          expect(ingested.jobArn).toBeTruthy();

          // GetDataAutomationLibraryIngestionJob — any lifecycle status
          // proves the grant + library injection.
          const job = (yield* send(
            HttpClientRequest.get(
              `${baseUrl}/library-ingestion-job?jobArn=${encodeURIComponent(ingested.jobArn!)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as { status?: string };
          expect([
            "IN_PROGRESS",
            "COMPLETED",
            "COMPLETED_WITH_ERRORS",
            "FAILED",
          ]).toContain(job.status);

          // ListDataAutomationLibraryIngestionJobs — the job we just
          // started must be visible.
          const jobs = (yield* send(
            HttpClientRequest.get(`${baseUrl}/library-ingestion-jobs`),
          ).pipe(Effect.flatMap((r) => r.json))) as { count: number };
          expect(jobs.count).toBeGreaterThanOrEqual(1);

          // ListDataAutomationLibraryEntities — entity visibility lags the
          // async job, so only the successful (authorized) empty-or-more
          // page is asserted.
          const entities = (yield* send(
            HttpClientRequest.get(`${baseUrl}/library-entities`),
          ).pipe(Effect.flatMap((r) => r.json))) as { count: number };
          expect(entities.count).toBeGreaterThanOrEqual(0);

          // GetDataAutomationLibraryEntity — typed not-found path proves
          // the grant (an IAM gap would surface AccessDeniedException).
          const missing = (yield* send(
            HttpClientRequest.get(`${baseUrl}/library-entity-missing`),
          ).pipe(Effect.flatMap((r) => r.json))) as { tag: string };
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(missing.tag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Blueprint management", () => {
    test.provider(
      "creates a blueprint version and drives copy-stage's typed error path",
      (_stack) =>
        Effect.gen(function* () {
          // CreateBlueprintVersion — snapshots the fixture blueprint.
          const version = (yield* send(
            HttpClientRequest.post(`${baseUrl}/blueprint-version`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            version?: string;
            error?: string;
            message?: string;
          };
          expect(
            version.error === undefined
              ? "none"
              : `${version.error}: ${version.message}`,
          ).toBe("none");
          expect(version.version).toBeTruthy();

          // CopyBlueprintStage — the fixture blueprint has no DEVELOPMENT
          // stage, so the typed error tag proves the grant + injection
          // without creating a stage copy.
          const copied = (yield* send(
            HttpClientRequest.post(`${baseUrl}/copy-stage-validation`),
          ).pipe(Effect.flatMap((r) => r.json))) as { tag: string };
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(copied.tag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Blueprint optimization", () => {
    test.provider(
      "drives the typed error paths of optimize + status polling",
      (_stack) =>
        Effect.gen(function* () {
          // InvokeBlueprintOptimizationAsync — an empty samples list is
          // invalid, so the typed ValidationException proves the grant +
          // blueprint injection without paying for a real optimization job.
          const arn = yield* getProfileArn;
          const optimize = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/optimize-validation?profileArn=${encodeURIComponent(arn)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as { tag: string };
          expect(optimize.tag).toBe("ValidationException");

          // GetBlueprintOptimizationStatus — typed not-found on a
          // well-formed but nonexistent invocation ARN.
          const { Account } = yield* sts.getCallerIdentity({});
          const region = yield* Effect.sync(
            () => process.env.AWS_REGION ?? "us-west-2",
          );
          const missingArn = `arn:aws:bedrock:${region}:${Account}:blueprint-optimization-invocation/00000000-0000-0000-0000-000000000000`;
          const status = (yield* send(
            HttpClientRequest.get(
              `${baseUrl}/optimization-status-missing?invocationArn=${encodeURIComponent(missingArn)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as { tag: string };
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(status.tag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("InvokeDataAutomation", () => {
    // The sync API needs a SYNC project and a non-empty input; the fixture
    // drives the binding through its typed ValidationException path — an IAM
    // gap would surface AccessDeniedException (a 500) instead of the tag.
    test.provider(
      "surfaces the typed ValidationException for an empty input",
      (_stack) =>
        Effect.gen(function* () {
          const arn = yield* getProfileArn;
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/invoke-sync-validation?profileArn=${encodeURIComponent(arn)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as { tag: string };
          expect(response.tag).toBe("ValidationException");
        }),
      { timeout: 120_000 },
    );
  });
});
