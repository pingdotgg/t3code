import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as lambda from "@distilled.cloud/aws/lambda";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CloudWatchTestFunctionLive, {
  CloudWatchTestFunction,
  METRIC_NAME,
} from "./handler";

// Runtime binding coverage for every CloudWatch capability that can be
// exercised against fixture-deployable resources. Two bindings have no
// route here (documented, not silently dropped):
//
// - GetAlarmMuteRule — binding requires a deployed AlarmMuteRule, but
//   `putAlarmMuteRule` currently rejects every input with an empty-message
//   ValidationException (see AlarmMuteRule.test.ts). ListAlarmMuteRules is
//   covered below without a resource.
// - GetMetricStream / StartMetricStreams / StopMetricStreams — bindings
//   require a deployed MetricStream, which needs a live Firehose delivery
//   stream + IAM roles and is gated behind AWS_TEST_METRICSTREAM at the
//   resource level (see MetricStream.test.ts). ListMetricStreams is covered
//   below without a resource.

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudWatchBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load. Budget ~150s of
// readiness polling so we don't fail the whole suite on a slow init.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let fixtureFunctionName: string | undefined;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// full-suite parallel load — a cold re-init or an IAM-propagation race the
// handler's `Effect.orDie` surfaces as a 500. Only 5xx is retried; a genuine
// 4xx/assertion failure is returned immediately.
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

describe("CloudWatch Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "CloudWatch test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("CloudWatch test setup: deploying fixture");
      const { functionUrl, functionName } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CloudWatchTestFunction;
        }).pipe(Effect.provide(CloudWatchTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      fixtureFunctionName = functionName;

      yield* Effect.logInfo(
        `CloudWatch test setup: probing readiness at ${baseUrl}/health`,
      );
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
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

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Out-of-band assert-gone: the fixture Lambda (root of the deployed
      // stack) no longer exists after the trailing destroy. `afterAll`
      // doesn't run inside `test.provider`'s environment, so provide the
      // AWS providers (Credentials/Region) explicitly for the distilled call.
      if (fixtureFunctionName !== undefined) {
        const gone = yield* Core.withProviders(
          lambda.getFunction({ FunctionName: fixtureFunctionName }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          ),
          testOptions,
          "CloudWatchBindings",
        );
        expect(gone).toBe(true);
      }
    }),
    { timeout: 120_000 },
  );

  // ── Metrics ──────────────────────────────────────────────────────────────

  describe("PutMetricData", () => {
    test.provider("puts a custom metric datum", (_stack) =>
      Effect.gen(function* () {
        const response = yield* postJson("/put-metric-data");
        expect(response).toHaveProperty("ok", true);
      }),
    );
  });

  describe("ListMetrics", () => {
    test.provider("lists metrics in the fixture namespace", (_stack) =>
      Effect.gen(function* () {
        // Freshly-put metric data can take minutes to appear in ListMetrics —
        // assert the authorized call returns a well-formed collection.
        const response = (yield* getJson("/list-metrics")) as {
          metrics: unknown[];
        };
        expect(Array.isArray(response.metrics)).toBe(true);
      }),
    );
  });

  describe("GetMetricData", () => {
    test.provider("queries the fixture metric", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/get-metric-data")) as {
          results: { Id?: string }[];
        };
        expect(response.results.length).toBe(1);
        expect(response.results[0].Id).toBe("m1");
      }),
    );
  });

  describe("GetMetricStatistics", () => {
    test.provider("returns statistics for the fixture metric", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/get-metric-statistics")) as {
          label?: string;
          datapoints: unknown[];
        };
        expect(response.label).toBe(METRIC_NAME);
        expect(Array.isArray(response.datapoints)).toBe(true);
      }),
    );
  });

  describe("GetMetricWidgetImage", () => {
    test.provider("renders a metric widget image", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/get-metric-widget-image")) as {
          bytes: number;
        };
        expect(response.bytes).toBeGreaterThan(0);
      }),
    );
  });

  // ── Alarms ───────────────────────────────────────────────────────────────

  describe("DescribeAlarms", () => {
    test.provider("describes the bound alarm", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/describe-alarms")) as {
          alarmName: string;
          alarms: string[];
        };
        expect(response.alarms).toContain(response.alarmName);
      }),
    );
  });

  describe("DescribeAlarmsForMetric", () => {
    test.provider("finds the alarm by its metric", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/describe-alarms-for-metric")) as {
          alarmName: string;
          alarms: string[];
        };
        expect(response.alarms).toContain(response.alarmName);
      }),
    );
  });

  describe("SetAlarmState", () => {
    test.provider("sets the alarm state to OK", (_stack) =>
      Effect.gen(function* () {
        const response = yield* postJson("/set-alarm-state");
        expect(response).toHaveProperty("ok", true);
      }),
    );
  });

  describe("DescribeAlarmHistory", () => {
    test.provider("returns history for the bound alarm", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/describe-alarm-history")) as {
          items: unknown[];
        };
        expect(Array.isArray(response.items)).toBe(true);
      }),
    );
  });

  describe("DescribeAlarmContributors", () => {
    test.provider("is authorized against the bound alarm", (_stack) =>
      Effect.gen(function* () {
        // A plain metric alarm has no contributor data; the typed
        // ValidationException (observed live) or ResourceNotFoundException is
        // the expected outcome, and a successful contributor list is equally
        // valid. Any of these proves binding + IAM (auth failures die as 500).
        const response = (yield* getJson("/describe-alarm-contributors")) as
          | { ok: true; contributors: unknown[] }
          | { ok: false; error: string };
        if (response.ok) {
          expect(Array.isArray(response.contributors)).toBe(true);
        } else {
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(response.error);
        }
      }),
    );
  });

  describe("DisableAlarmActions", () => {
    test.provider("disables actions on the bound alarm", (_stack) =>
      Effect.gen(function* () {
        const response = yield* postJson("/disable-alarm-actions");
        expect(response).toHaveProperty("ok", true);
      }),
    );
  });

  describe("EnableAlarmActions", () => {
    test.provider("re-enables actions on the bound alarm", (_stack) =>
      Effect.gen(function* () {
        const response = yield* postJson("/enable-alarm-actions");
        expect(response).toHaveProperty("ok", true);
      }),
    );
  });

  describe("ListTagsForResource", () => {
    test.provider("lists the alarm's internal tags", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/list-tags-for-resource")) as {
          tags: { Key: string; Value: string }[];
        };
        // Every alchemy-managed alarm carries internal branding tags.
        expect(response.tags.length).toBeGreaterThan(0);
      }),
    );
  });

  // ── Dashboards ───────────────────────────────────────────────────────────

  describe("GetDashboard", () => {
    test.provider("gets the bound dashboard", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/get-dashboard")) as {
          dashboardName: string;
          name?: string;
          body?: string;
        };
        expect(response.name).toBe(response.dashboardName);
        expect(response.body).toContain("widgets");
      }),
    );
  });

  describe("ListDashboards", () => {
    test.provider("lists the deployed dashboard", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/list-dashboards")) as {
          dashboardName: string;
          entries: string[];
        };
        expect(response.entries).toContain(response.dashboardName);
      }),
    );
  });

  // ── Contributor Insights ─────────────────────────────────────────────────

  describe("DescribeInsightRules", () => {
    test.provider("lists the deployed insight rule", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/describe-insight-rules")) as {
          ruleName: string;
          rules: string[];
        };
        expect(response.rules).toContain(response.ruleName);
      }),
    );
  });

  describe("GetInsightRuleReport", () => {
    test.provider("returns a report for the deployed rule", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/get-insight-rule-report")) as {
          ok: boolean;
          contributors: unknown[];
        };
        expect(response.ok).toBe(true);
        expect(Array.isArray(response.contributors)).toBe(true);
      }),
    );
  });

  describe("DisableInsightRules", () => {
    test.provider("disables the deployed rule without failures", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* postJson("/disable-insight-rules")) as {
          failures: unknown[];
        };
        expect(response.failures).toEqual([]);
      }),
    );
  });

  describe("EnableInsightRules", () => {
    test.provider("re-enables the deployed rule without failures", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* postJson("/enable-insight-rules")) as {
          failures: unknown[];
        };
        expect(response.failures).toEqual([]);
      }),
    );
  });

  describe("ListManagedInsightRules", () => {
    test.provider("is authorized for the probe resource", (_stack) =>
      Effect.gen(function* () {
        // Managed Contributor Insights rules only exist for specific AWS
        // resource types; probing with the alarm ARN either returns rules or
        // the typed InvalidParameterValueException. Either proves the
        // binding is wired and authorized (auth failures surface as 500s).
        const response = (yield* getJson("/list-managed-insight-rules")) as
          | { ok: true; rules: unknown[] }
          | { ok: false; error: string };
        if (response.ok) {
          expect(Array.isArray(response.rules)).toBe(true);
        } else {
          expect(response.error).toBe("InvalidParameterValueException");
        }
      }),
    );
  });

  // ── Anomaly detectors ────────────────────────────────────────────────────

  describe("DescribeAnomalyDetectors", () => {
    test.provider("finds the deployed anomaly detector", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/describe-anomaly-detectors")) as {
          detectors: {
            SingleMetricAnomalyDetector?: { MetricName?: string };
            MetricName?: string;
          }[];
        };
        expect(
          response.detectors.some(
            (d) =>
              d.MetricName === METRIC_NAME ||
              d.SingleMetricAnomalyDetector?.MetricName === METRIC_NAME,
          ),
        ).toBe(true);
      }),
    );
  });

  // ── Alarm mute rules / metric streams ────────────────────────────────────

  describe("ListAlarmMuteRules", () => {
    test.provider("lists alarm mute rules in the region", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/list-alarm-mute-rules")) as {
          summaries: unknown[];
        };
        expect(Array.isArray(response.summaries)).toBe(true);
      }),
    );
  });

  describe("ListMetricStreams", () => {
    test.provider("lists metric streams in the region", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/list-metric-streams")) as {
          entries: unknown[];
        };
        expect(Array.isArray(response.entries)).toBe(true);
      }),
    );
  });
});
