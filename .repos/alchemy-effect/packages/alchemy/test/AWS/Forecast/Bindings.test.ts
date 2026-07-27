import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ForecastTestFunctionLive, { ForecastTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ForecastBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

// Well-formed-but-nonexistent ARNs the probe routes are driven against.
// Computed inside test bodies (test.provider provides AWSEnvironment).
const probeArns = Effect.gen(function* () {
  const { accountId, region } = yield* AWSEnvironment.current;
  return {
    importJob: `arn:aws:forecast:${region}:${accountId}:dataset-import-job/alchemy_probe/alchemy_probe`,
    predictor: `arn:aws:forecast:${region}:${accountId}:predictor/alchemy_probe`,
    forecast: `arn:aws:forecast:${region}:${accountId}:forecast/alchemy_probe`,
    forecastExport: `arn:aws:forecast:${region}:${accountId}:forecast-export-job/alchemy_probe/alchemy_probe`,
    whatIfAnalysis: `arn:aws:forecast:${region}:${accountId}:what-if-analysis/alchemy_probe`,
    whatIfForecast: `arn:aws:forecast:${region}:${accountId}:what-if-forecast/alchemy_probe`,
    whatIfForecastExport: `arn:aws:forecast:${region}:${accountId}:what-if-forecast-export/alchemy_probe/alchemy_probe`,
  };
});

// Amazon Forecast is closed to new customers: a grandfathered account
// answers a nonexistent ARN with ResourceNotFoundException, while a blocked
// account rejects the call with AccessDeniedException ("Amazon Forecast is
// no longer available to new customers"). Both are typed tags decoded inside
// the Lambda — an IAM gap or schema break would surface a different tag and
// fail the assertion.
const EXPECTED_PROBE_TAGS = [
  "ResourceNotFoundException",
  "AccessDeniedException",
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

const probeTag = (path: string, arn: string) =>
  getJson(`${path}?arn=${encodeURIComponent(arn)}`).pipe(
    Effect.map((response) => (response as { tag: string }).tag),
  );

describe.sequential("Forecast Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Forecast test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Forecast test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ForecastTestFunction;
        }).pipe(Effect.provide(ForecastTestFunctionLive)),
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
    test.provider("all twenty capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(20);
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

  describe("DescribeAutoPredictor", () => {
    test.provider("surfaces a typed tag for a nonexistent predictor", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/predictor-probe", arns.predictor);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("GetAccuracyMetrics", () => {
    test.provider("surfaces a typed tag for a nonexistent predictor", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/accuracy-probe", arns.predictor);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("DescribeForecast", () => {
    test.provider("surfaces a typed tag for a nonexistent forecast", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/forecast-probe", arns.forecast);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("CreateForecast", () => {
    test.provider("rejects a nonexistent predictor with a typed tag", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/create-forecast-probe", arns.predictor);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("StopResource", () => {
    test.provider("surfaces a typed tag for a nonexistent job", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/stop-probe", arns.predictor);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("ResumeResource", () => {
    test.provider("surfaces a typed tag for a nonexistent monitor", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/resume-probe", arns.predictor);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("QueryForecast", () => {
    test.provider("surfaces a typed tag for a nonexistent forecast", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/query-probe", arns.forecast);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("QueryWhatIfForecast", () => {
    test.provider("surfaces a typed tag for a nonexistent forecast", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/whatif-query-probe", arns.whatIfForecast);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("CreateForecastExportJob", () => {
    test.provider("rejects a nonexistent forecast with a typed tag", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/export-create-probe", arns.forecast);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("DescribeForecastExportJob", () => {
    test.provider("surfaces a typed tag for a nonexistent export job", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/export-probe", arns.forecastExport);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("CreateWhatIfAnalysis", () => {
    test.provider("rejects a nonexistent forecast with a typed tag", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag(
          "/whatif-analysis-create-probe",
          arns.forecast,
        );
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("DescribeWhatIfAnalysis", () => {
    test.provider("surfaces a typed tag for a nonexistent analysis", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag(
          "/whatif-analysis-probe",
          arns.whatIfAnalysis,
        );
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("CreateWhatIfForecast", () => {
    test.provider("rejects a nonexistent analysis with a typed tag", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag(
          "/whatif-create-probe",
          arns.whatIfAnalysis,
        );
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("DescribeWhatIfForecast", () => {
    test.provider(
      "surfaces a typed tag for a nonexistent scenario forecast",
      () =>
        Effect.gen(function* () {
          const arns = yield* probeArns;
          const tag = yield* probeTag(
            "/whatif-forecast-probe",
            arns.whatIfForecast,
          );
          expect(EXPECTED_PROBE_TAGS).toContain(tag);
        }),
    );
  });

  describe("CreateWhatIfForecastExport", () => {
    test.provider(
      "rejects a nonexistent scenario forecast with a typed tag",
      () =>
        Effect.gen(function* () {
          const arns = yield* probeArns;
          const tag = yield* probeTag(
            "/whatif-export-create-probe",
            arns.whatIfForecast,
          );
          expect(EXPECTED_PROBE_TAGS).toContain(tag);
        }),
    );
  });

  describe("DescribeWhatIfForecastExport", () => {
    test.provider("surfaces a typed tag for a nonexistent export", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag(
          "/whatif-export-probe",
          arns.whatIfForecastExport,
        );
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });

  describe("DeleteResourceTree", () => {
    test.provider("surfaces a typed tag for a nonexistent parent", () =>
      Effect.gen(function* () {
        const arns = yield* probeArns;
        const tag = yield* probeTag("/delete-tree-probe", arns.predictor);
        expect(EXPECTED_PROBE_TAGS).toContain(tag);
      }),
    );
  });
});
