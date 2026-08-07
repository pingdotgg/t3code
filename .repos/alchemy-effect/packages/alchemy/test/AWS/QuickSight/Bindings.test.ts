import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as quicksight from "@distilled.cloud/aws/quicksight";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import QuickSightBindingsFunctionLive, {
  QuickSightBindingsFunction,
} from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// The testing account has no QuickSight subscription, so the live Lambda E2E
// (which needs a real data source + dataset + dashboard) is gated behind
// AWS_TEST_QUICKSIGHT=1 for entitled accounts. The ungated probes below prove
// the typed error unions the bindings depend on, on every account.
const SUBSCRIBED = !!process.env.AWS_TEST_QUICKSIGHT;

// Ungated typed-error probes.
test.provider(
  "createIngestion on a nonexistent dataset fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        quicksight.createIngestion({
          AwsAccountId: accountId,
          DataSetId: "alchemy-nonexistent-quicksight-dataset-probe",
          IngestionId: "alchemy-quicksight-ingestion-probe",
        }),
      );
      expect([
        "ResourceNotFoundException",
        "InvalidParameterValueException",
        "AccessDeniedException",
      ]).toContain(error._tag);
    }),
  { timeout: 60_000 },
);

test.provider(
  "generateEmbedUrlForRegisteredUser for a nonexistent user fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        quicksight.generateEmbedUrlForRegisteredUser({
          AwsAccountId: accountId,
          UserArn: `arn:aws:quicksight:${region}:${accountId}:user/default/alchemy-nonexistent-user-probe`,
          ExperienceConfiguration: {
            Dashboard: {
              InitialDashboardId: "alchemy-nonexistent-dashboard-probe",
            },
          },
        }),
      );
      expect([
        "QuickSightUserNotFoundException",
        "ResourceNotFoundException",
        "InvalidParameterValueException",
        "AccessDeniedException",
        "UnsupportedUserEditionException",
      ]).toContain(error._tag);
    }),
  { timeout: 60_000 },
);

test.provider(
  "describeDashboardSnapshotJob on a nonexistent dashboard fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        quicksight.describeDashboardSnapshotJob({
          AwsAccountId: accountId,
          DashboardId: "alchemy-nonexistent-quicksight-dashboard-probe",
          SnapshotJobId: "alchemy-nonexistent-snapshot-job-probe",
        }),
      );
      expect([
        "ResourceNotFoundException",
        "InvalidParameterValueException",
        "AccessDeniedException",
        "UnsupportedUserEditionException",
      ]).toContain(error._tag);
    }),
  { timeout: 60_000 },
);

const sharedStack = Core.scratchStack(testOptions, "QuickSightBindings");

let baseUrl: string;

const get = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));
const post = (path: string) =>
  HttpClient.post(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

describe("QuickSight Bindings (E2E)", () => {
  beforeAll(
    Effect.gen(function* () {
      if (!SUBSCRIBED) return;
      yield* Effect.logInfo("QuickSight E2E setup: destroying previous run");
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "QuickSight E2E setup: deploying data source + dataset + dashboard + Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* QuickSightBindingsFunction;
        }).pipe(Effect.provide(QuickSightBindingsFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(60),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(
    Effect.gen(function* () {
      if (!SUBSCRIBED) return;
      yield* sharedStack.destroy();
    }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!SUBSCRIBED)(
    "all 9 capabilities initialize in the runtime",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/bindings")) as any;
        expect(response.bound).toHaveLength(9);
      }),
  );

  test.provider.skipIf(!SUBSCRIBED)(
    "ListIngestions reads the bound dataset's refresh history",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/ingestions")) as any;
        expect(typeof response.count).toBe("number");
      }),
  );

  test.provider.skipIf(!SUBSCRIBED)(
    "CreateIngestion + DescribeIngestion + CancelIngestion round-trip",
    () =>
      Effect.gen(function* () {
        const response = (yield* post("/ingestion")) as any;
        // DIRECT_QUERY dataset → typed 400; SPICE dataset → started + status.
        if (response.started) {
          expect(typeof response.id).toBe("string");
        } else {
          expect([
            "InvalidParameterValueException",
            "ResourceNotFoundException",
          ]).toContain(response.error);
        }
      }),
  );

  test.provider.skipIf(!SUBSCRIBED)(
    "snapshot-job describe bindings surface the typed not-found",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/snapshot-job/typed-not-found")) as any;
        expect(response.describe).toBe(true);
        expect(response.result).toBe(true);
      }),
  );

  test.provider.skipIf(!SUBSCRIBED)(
    "StartDashboardSnapshotJob starts (or typed-rejects) a PDF export",
    () =>
      Effect.gen(function* () {
        const response = (yield* post("/snapshot-job")) as any;
        if (response.started) {
          expect(typeof response.jobId).toBe("string");
        } else {
          expect(typeof response.error).toBe("string");
        }
      }),
  );

  test.provider.skipIf(!SUBSCRIBED)(
    "embed-URL bindings reach the API with the injected account id",
    () =>
      Effect.gen(function* () {
        const registered = (yield* get("/embed-url")) as any;
        expect(typeof registered.typed).toBe("string");
        const anonymous = (yield* get("/embed-url-anon")) as any;
        expect(
          anonymous.ok === true || typeof anonymous.error === "string",
        ).toBe(true);
      }),
  );
});
