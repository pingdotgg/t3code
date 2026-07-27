import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as personalize from "@distilled.cloud/aws/personalize";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import PersonalizeTestFunctionLive, {
  PersonalizeTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "PersonalizeBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

// Well-formed-but-nonexistent ARNs the probe routes are driven against —
// training a solution/campaign takes ~an hour of paid compute, so the
// campaign/solution routes only prove the IAM bind + typed error decode.
const probeArns = Effect.gen(function* () {
  const { accountId, region } = yield* AWSEnvironment.current;
  return {
    dataset: `arn:aws:personalize:${region}:${accountId}:dataset/alchemy-probe/INTERACTIONS`,
    importJob: `arn:aws:personalize:${region}:${accountId}:dataset-import-job/alchemy-probe`,
    datasetGroup: `arn:aws:personalize:${region}:${accountId}:dataset-group/alchemy-probe`,
    solution: `arn:aws:personalize:${region}:${accountId}:solution/alchemy-probe`,
    solutionVersion: `arn:aws:personalize:${region}:${accountId}:solution/alchemy-probe/0123456789abcdef`,
    campaign: `arn:aws:personalize:${region}:${accountId}:campaign/alchemy-probe`,
    batchJob: `arn:aws:personalize:${region}:${accountId}:batch-inference-job/alchemy-probe`,
  };
});

// A nonexistent target answers ResourceNotFoundException; malformed-but-
// plausible inputs can surface InvalidInputException. Both are typed tags
// decoded inside the Lambda — an IAM gap or schema break would surface a
// different tag (AccessDeniedException / UnknownAwsError) and fail.
const EXPECTED_PROBE_TAGS = [
  "ResourceNotFoundException",
  "InvalidInputException",
];

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

// IAM policy statements on a freshly-created role can take up to ~a minute to
// propagate to the Personalize data plane, surfacing as a transient
// AccessDeniedException tag. Retry (bounded) until a different tag appears —
// a genuine IAM gap still fails the assertion with the AccessDeniedException
// tag after the retries are exhausted.
const routeTag = (path: string) =>
  getJson(path).pipe(
    Effect.map((response) => (response as { tag: string }).tag),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (tag: string): boolean => tag !== "AccessDeniedException",
      times: 20,
    }),
  );

const probeTag = (path: string, arn: string) =>
  routeTag(`${path}?arn=${encodeURIComponent(arn)}`);

// Create-probes that pass a data-access role: use a nonexistent role in OUR
// account so the service validates (and 404s) the primary resource rather
// than tripping cross-account PassRole checks.
const probeTagWithRole = (path: string, arn: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* AWSEnvironment.current;
    const role = `arn:aws:iam::${accountId}:role/alchemy-nonexistent-probe-role`;
    return yield* routeTag(
      `${path}?arn=${encodeURIComponent(arn)}&role=${encodeURIComponent(role)}`,
    );
  });

describe.sequential("Personalize Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Personalize test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Personalize test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* PersonalizeTestFunction;
        }).pipe(Effect.provide(PersonalizeTestFunctionLive)),
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
    { timeout: 480_000 },
  );

  // Assert the fixture's Personalize resources are gone out-of-band after the
  // destroy. Dataset-group deletion is asynchronous (DELETE IN_PROGRESS), so
  // poll until no group with this suite's stack prefix remains; the datasets
  // and the auto-created event schema disappear with it. `withProviders`
  // supplies the AWS environment the raw distilled calls need.
  const assertPersonalizeResourcesGone = Core.withProviders(
    Effect.gen(function* () {
      const prefix = `${sharedStack.name}-`;
      const groups = yield* personalize.listDatasetGroups({}).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (response): boolean =>
            !(response.datasetGroups ?? []).some((group) =>
              group.name?.startsWith(prefix),
            ),
          times: 24,
        }),
      );
      expect(
        (groups.datasetGroups ?? [])
          .map((group) => group.name)
          .filter((name) => name?.startsWith(prefix)),
      ).toEqual([]);
      const trackers = yield* personalize.listEventTrackers({});
      expect(
        (trackers.eventTrackers ?? [])
          .map((tracker) => tracker.name)
          .filter((name) => name?.startsWith(prefix)),
      ).toEqual([]);
      // The user-defined schemas are deleted synchronously by the destroy;
      // the group's auto-created event schema goes with the group deletion.
      const schemas = yield* personalize.listSchemas({}).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (response): boolean =>
            !(response.schemas ?? []).some((schema) =>
              schema.name?.startsWith(prefix),
            ),
          times: 12,
        }),
      );
      expect(
        (schemas.schemas ?? [])
          .map((schema) => schema.name)
          .filter((name) => name?.startsWith(prefix)),
      ).toEqual([]);
    }),
    testOptions,
    sharedStack.name,
  );

  afterAll(
    sharedStack.destroy().pipe(Effect.andThen(assertPersonalizeResourcesGone)),
    { timeout: 420_000 },
  );

  describe("binding registration", () => {
    test.provider("all nineteen capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(19);
      }),
    );
  });

  describe("PutEvents", () => {
    test.provider("records a real event through the event tracker", () =>
      Effect.gen(function* () {
        const tag = yield* routeTag("/put-events");
        expect(tag).toBe("Recorded");
      }),
    );
  });

  describe("PutItems", () => {
    test.provider("upserts a real item into the Items dataset", () =>
      Effect.gen(function* () {
        const tag = yield* routeTag("/put-items");
        expect(tag).toBe("Recorded");
      }),
    );
  });

  describe("PutUsers", () => {
    test.provider("upserts a real user into the Users dataset", () =>
      Effect.gen(function* () {
        const tag = yield* routeTag("/put-users");
        expect(tag).toBe("Recorded");
      }),
    );
  });

  describe("PutActions", () => {
    test.provider(
      "surfaces a typed tag when the bound dataset is not an Actions dataset",
      () =>
        Effect.gen(function* () {
          const tag = yield* routeTag("/put-actions-probe");
          expect(EXPECTED_PROBE_TAGS).toContain(tag);
        }),
    );
  });

  describe("PutActionInteractions", () => {
    test.provider(
      "surfaces a typed tag without an Action interactions dataset",
      () =>
        Effect.gen(function* () {
          const tag = yield* routeTag("/put-action-interactions-probe");
          expect(EXPECTED_PROBE_TAGS).toContain(tag);
        }),
    );
  });

  describe("GetRecommendations", () => {
    test.provider("surfaces a typed tag for a nonexistent campaign", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/recommendations-probe", arns.campaign);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("GetPersonalizedRanking", () => {
    test.provider("surfaces a typed tag for a nonexistent campaign", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/ranking-probe", arns.campaign);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("GetActionRecommendations", () => {
    test.provider("surfaces a typed tag for a nonexistent campaign", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag(
          "/action-recommendations-probe",
          arns.campaign,
        );
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("CreateDatasetImportJob", () => {
    test.provider("rejects a nonexistent dataset with a typed tag", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTagWithRole(
          "/import-create-probe",
          arns.dataset,
        );
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("DescribeDatasetImportJob", () => {
    test.provider("surfaces a typed tag for a nonexistent import job", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/import-probe", arns.importJob);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("CreateSolution", () => {
    test.provider("rejects a nonexistent dataset group with a typed tag", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag(
          "/solution-create-probe",
          arns.datasetGroup,
        );
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("CreateSolutionVersion", () => {
    test.provider("rejects a nonexistent solution with a typed tag", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag(
          "/solution-version-create-probe",
          arns.solution,
        );
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("DescribeSolutionVersion", () => {
    test.provider("surfaces a typed tag for a nonexistent version", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag(
          "/solution-version-probe",
          arns.solutionVersion,
        );
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("GetSolutionMetrics", () => {
    test.provider("surfaces a typed tag for a nonexistent version", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag(
          "/solution-metrics-probe",
          arns.solutionVersion,
        );
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("CreateCampaign", () => {
    test.provider(
      "rejects a nonexistent solution version with a typed tag",
      () =>
        Effect.gen(function* () {
          const arns = yield* probeArns;
          const tag = yield* probeTag(
            "/campaign-create-probe",
            arns.solutionVersion,
          );
          expect(EXPECTED_PROBE_TAGS).toContain(tag);
        }),
    );
  });

  describe("UpdateCampaign", () => {
    test.provider("surfaces a typed tag for a nonexistent campaign", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/campaign-update-probe", arns.campaign);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("DescribeCampaign", () => {
    test.provider("surfaces a typed tag for a nonexistent campaign", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/campaign-probe", arns.campaign);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("CreateBatchInferenceJob", () => {
    test.provider(
      "rejects a nonexistent solution version with a typed tag",
      () =>
        Effect.gen(function* () {
          const arns = yield* probeArns;
          const tag = yield* probeTagWithRole(
            "/batch-create-probe",
            arns.solutionVersion,
          );
          expect(EXPECTED_PROBE_TAGS).toContain(tag);
        }),
    );
  });

  describe("DescribeBatchInferenceJob", () => {
    test.provider("surfaces a typed tag for a nonexistent batch job", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/batch-probe", arns.batchJob);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });
});
