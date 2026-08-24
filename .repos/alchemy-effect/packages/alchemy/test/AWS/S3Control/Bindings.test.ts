import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { Region } from "@distilled.cloud/aws/Region";
import * as s3control from "@distilled.cloud/aws/s3-control";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import S3ControlBindingsFunctionLive, {
  S3ControlBindingsFunction,
} from "./fixtures/bindings-handler.ts";
import S3ControlMrapBindingsFunctionLive, {
  S3ControlMrapBindingsFunction,
} from "./fixtures/mrap-bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "S3ControlBindings");
const mrapStack = Core.scratchStack(testOptions, "S3ControlMrapBindings");
const ACCOUNT_ID = "391965393224";

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

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
      while: (e): boolean => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const getJson = (baseUrl: string, path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const awaitReady = (readinessUrl: string) =>
  HttpClient.get(readinessUrl).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : Effect.fail(new Error(`Function not ready: ${response.status}`)),
    ),
    Effect.tapError((error) =>
      Effect.logWarning(
        `S3Control test setup: fixture not ready yet (${String(error)})`,
      ),
    ),
    Effect.retry({ schedule: readinessPolicy }),
  );

let baseUrl: string;

describe.sequential("AWS.S3Control bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "S3Control test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("S3Control test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* S3ControlBindingsFunction;
        }).pipe(Effect.provide(S3ControlBindingsFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      yield* awaitReady(`${baseUrl}/bindings`);
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  describe("binding registration", () => {
    test.provider("all nine capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson(baseUrl, "/bindings")) as {
          bound: string[];
        };
        expect(response.bound).toHaveLength(9);
      }),
    );
  });

  describe("GetAccessPoint", () => {
    test.provider("reads the access point's live configuration", (_stack) =>
      Effect.gen(function* () {
        const live = (yield* getJson(baseUrl, "/access-point")) as {
          name: string | undefined;
          bucket: string | undefined;
          networkOrigin: string | undefined;
        };
        expect(live.name).toBeTruthy();
        expect(live.bucket).toBeTruthy();
        expect(live.networkOrigin).toBe("Internet");
      }),
    );
  });

  describe("GetAccessPointPolicy", () => {
    test.provider(
      "typed NoSuchAccessPointPolicy on a policyless access point",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* getJson(baseUrl, "/policy")) as {
            hasPolicy: boolean;
          };
          expect(result.hasPolicy).toBe(false);
        }),
    );
  });

  describe("GetAccessPointPolicyStatus", () => {
    test.provider("reports the access point as non-public", (_stack) =>
      Effect.gen(function* () {
        const result = (yield* getJson(baseUrl, "/policy-status")) as {
          isPublic: boolean;
          hasPolicy: boolean;
        };
        expect(result.isPublic).toBe(false);
      }),
    );
  });

  describe("ListAccessPoints", () => {
    test.provider("finds the fixture access point by bucket", (_stack) =>
      Effect.gen(function* () {
        const live = (yield* getJson(baseUrl, "/access-point")) as {
          name: string | undefined;
        };
        const { names } = (yield* getJson(baseUrl, "/access-points")) as {
          names: string[];
        };
        expect(names).toContain(live.name);
      }),
    );
  });

  describe("CreateJob + DescribeJob + UpdateJobPriority + UpdateJobStatus + ListJobs", () => {
    test.provider(
      "runs the batch job loop: create suspended, describe, bump priority, cancel, list",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* getJson(baseUrl, "/job-lifecycle")) as {
            ok: boolean;
            tag?: string;
            message?: string;
            jobId: string;
            settledStatus: string;
            priorityOutcome: string;
            cancelOutcome: string;
            finalStatus: string;
            listedJobIds: string[];
          };
          expect(
            result.ok,
            `job flow failed: ${result.tag}: ${result.message}`,
          ).toBe(true);
          expect(result.jobId).toBeTruthy();
          // The job settles into a stable state (Suspended when awaiting
          // confirmation; Failed/Complete when the generated manifest is
          // empty).
          expect([
            "Suspended",
            "Failed",
            "Complete",
            "Cancelled",
            "Ready",
            "Active",
          ]).toContain(result.settledStatus);
          // Both bindings round-trip: either the mutation applied, or AWS
          // refused the transition with the TYPED tag (which also proves the
          // distilled JobStatusTransitionForbidden patch end-to-end).
          expect(["updated", "JobStatusTransitionForbidden"]).toContain(
            result.priorityOutcome,
          );
          expect(result.cancelOutcome).toBeTruthy();
          expect(result.finalStatus).toBeTruthy();
          expect(result.listedJobIds).toContain(result.jobId);
        }),
      { timeout: 180_000 },
    );
  });
});

// Multi-Region Access Point provisioning is asynchronous and can consume the
// entire 240s suite ceiling. Keep this explicitly gated; a hard-killed run
// must be audited by deterministic physical name before it is retried.
describe
  .skipIf(!process.env.AWS_TEST_SLOW)
  .sequential("AWS.S3Control MRAP route bindings (slow)", () => {
    let mrapBaseUrl: string;

    beforeAll(
      Effect.gen(function* () {
        yield* mrapStack.destroy();
        const attrs = yield* mrapStack.deploy(
          Effect.gen(function* () {
            return yield* S3ControlMrapBindingsFunction;
          }).pipe(Effect.provide(S3ControlMrapBindingsFunctionLive)),
        );
        expect(attrs.functionUrl).toBeTruthy();
        mrapBaseUrl = attrs.functionUrl!.replace(/\/+$/, "");
        yield* awaitReady(`${mrapBaseUrl}/routes`);
      }),
      { timeout: 240_000 },
    );

    afterAll(mrapStack.destroy(), { timeout: 240_000 });

    describe("GetMultiRegionAccessPointRoutes + SubmitMultiRegionAccessPointRoutes", () => {
      test.provider(
        "reads the routes and re-submits them at 100%",
        (_stack) =>
          Effect.gen(function* () {
            const before = (yield* getJson(mrapBaseUrl, "/routes")) as {
              mrapName: string;
              routes: { region: string; trafficDialPercentage: number }[];
            };
            expect(before.routes.length).toBeGreaterThan(0);

            const after = (yield* getJson(mrapBaseUrl, "/dial-100")) as {
              routes: { region: string; trafficDialPercentage: number }[];
            };
            expect(after.routes.length).toBe(before.routes.length);
            for (const route of after.routes) {
              expect(route.trafficDialPercentage).toBe(100);
            }

            // Verify the binding's mutation independently of the Lambda
            // response, through the distilled S3Control client.
            const live = yield* s3control
              .getMultiRegionAccessPointRoutes({
                AccountId: ACCOUNT_ID,
                Mrap: before.mrapName,
              })
              .pipe(Effect.provideService(Region, Effect.succeed("us-west-2")));
            expect(live.Routes?.length).toBe(before.routes.length);
            for (const route of live.Routes ?? []) {
              expect(route.TrafficDialPercentage).toBe(100);
            }
          }),
        { timeout: 120_000 },
      );
    });
  });
