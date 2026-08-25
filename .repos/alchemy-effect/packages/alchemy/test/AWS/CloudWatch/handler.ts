import * as CloudWatch from "@/AWS/CloudWatch";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Custom metric namespace used by the fixture's alarm, anomaly detector and
 * metric routes. Shared with Bindings.test.ts.
 */
export const METRIC_NAMESPACE = "Alchemy/CloudWatchBindings";
export const METRIC_NAME = "BindingTestMetric";

export class CloudWatchTestFunction extends Lambda.Function<Lambda.Function>()(
  "CloudWatchTestFunction",
) {}

export default CloudWatchTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // A metric alarm on a custom metric. Threshold is unreachably high and
    // TreatMissingData=notBreaching so the alarm sits in OK/INSUFFICIENT_DATA
    // and never pages anything.
    const alarm = yield* CloudWatch.Alarm("BindingAlarm", {
      MetricName: METRIC_NAME,
      Namespace: METRIC_NAMESPACE,
      Statistic: "Sum",
      Period: 60,
      EvaluationPeriods: 1,
      Threshold: 1_000_000,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
    });

    const dashboard = yield* CloudWatch.Dashboard("BindingDashboard", {
      DashboardBody: {
        widgets: [
          {
            type: "text",
            x: 0,
            y: 0,
            width: 6,
            height: 3,
            properties: {
              markdown: "# Alchemy CloudWatch bindings fixture",
            },
          },
        ],
      },
    });

    const insightRule = yield* CloudWatch.InsightRule("BindingInsightRule", {
      RuleState: "ENABLED",
      RuleDefinition: {
        Schema: {
          Name: "CloudWatchLogRule",
          Version: 1,
        },
        LogGroupNames: ["alchemy-test-cloudwatch-bindings-log-group"],
        LogFormat: "JSON",
        Contribution: {
          Keys: ["$.ip"],
          Filters: [],
        },
        AggregateOn: "Count",
      },
    });

    const detector = yield* CloudWatch.AnomalyDetector(
      "BindingAnomalyDetector",
      {
        Namespace: METRIC_NAMESPACE,
        MetricName: METRIC_NAME,
        Stat: "Sum",
      },
    );
    yield* detector.detectorId;

    // Bindings under test (one per CloudWatch capability).
    const describeAlarms = yield* CloudWatch.DescribeAlarms(alarm);
    const describeAlarmContributors =
      yield* CloudWatch.DescribeAlarmContributors(alarm);
    const describeAlarmHistory = yield* CloudWatch.DescribeAlarmHistory();
    const describeAlarmsForMetric = yield* CloudWatch.DescribeAlarmsForMetric();
    const describeAnomalyDetectors =
      yield* CloudWatch.DescribeAnomalyDetectors();
    const describeInsightRules = yield* CloudWatch.DescribeInsightRules();
    const disableAlarmActions = yield* CloudWatch.DisableAlarmActions(alarm);
    const enableAlarmActions = yield* CloudWatch.EnableAlarmActions(alarm);
    const disableInsightRules =
      yield* CloudWatch.DisableInsightRules(insightRule);
    const enableInsightRules =
      yield* CloudWatch.EnableInsightRules(insightRule);
    const getDashboard = yield* CloudWatch.GetDashboard(dashboard);
    const getInsightRuleReport =
      yield* CloudWatch.GetInsightRuleReport(insightRule);
    const getMetricData = yield* CloudWatch.GetMetricData();
    const getMetricStatistics = yield* CloudWatch.GetMetricStatistics();
    const getMetricWidgetImage = yield* CloudWatch.GetMetricWidgetImage();
    const listAlarmMuteRules = yield* CloudWatch.ListAlarmMuteRules();
    const listDashboards = yield* CloudWatch.ListDashboards();
    const listManagedInsightRules = yield* CloudWatch.ListManagedInsightRules();
    const listMetricStreams = yield* CloudWatch.ListMetricStreams();
    const listMetrics = yield* CloudWatch.ListMetrics();
    const listTagsForResource = yield* CloudWatch.ListTagsForResource(alarm);
    const putMetricData = yield* CloudWatch.PutMetricData();
    const setAlarmState = yield* CloudWatch.SetAlarmState(alarm);

    // Physical identifiers, bound into the runtime environment so routes can
    // echo them back for containment assertions in the test.
    const AlarmName = yield* alarm.alarmName;
    const AlarmArn = yield* alarm.alarmArn;
    const DashboardName = yield* dashboard.dashboardName;
    const RuleName = yield* insightRule.ruleName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/health") {
          return HttpServerResponse.text("ok");
        }

        // ── Metrics ────────────────────────────────────────────────────────

        if (request.method === "POST" && pathname === "/put-metric-data") {
          const result = yield* putMetricData({
            Namespace: METRIC_NAMESPACE,
            MetricData: [
              {
                MetricName: METRIC_NAME,
                Value: 1,
                Unit: "Count",
              },
            ],
          });
          return yield* HttpServerResponse.json({ ok: true, result });
        }

        if (request.method === "GET" && pathname === "/list-metrics") {
          const result = yield* listMetrics({ Namespace: METRIC_NAMESPACE });
          return yield* HttpServerResponse.json({
            metrics: result.Metrics ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/get-metric-data") {
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* getMetricData({
            StartTime: new Date(now - 3_600_000),
            EndTime: new Date(now),
            MetricDataQueries: [
              {
                Id: "m1",
                MetricStat: {
                  Metric: {
                    Namespace: METRIC_NAMESPACE,
                    MetricName: METRIC_NAME,
                  },
                  Period: 60,
                  Stat: "Sum",
                },
              },
            ],
          });
          return yield* HttpServerResponse.json({
            results: result.MetricDataResults ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/get-metric-statistics") {
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* getMetricStatistics({
            Namespace: METRIC_NAMESPACE,
            MetricName: METRIC_NAME,
            StartTime: new Date(now - 3_600_000),
            EndTime: new Date(now),
            Period: 60,
            Statistics: ["Sum"],
          });
          return yield* HttpServerResponse.json({
            label: result.Label,
            datapoints: result.Datapoints ?? [],
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/get-metric-widget-image"
        ) {
          const result = yield* getMetricWidgetImage({
            MetricWidget: JSON.stringify({
              metrics: [[METRIC_NAMESPACE, METRIC_NAME]],
              width: 300,
              height: 200,
              start: "-PT1H",
            }),
          });
          return yield* HttpServerResponse.json({
            bytes: result.MetricWidgetImage?.byteLength ?? 0,
          });
        }

        // ── Alarms ─────────────────────────────────────────────────────────

        if (request.method === "GET" && pathname === "/describe-alarms") {
          const result = yield* describeAlarms();
          return yield* HttpServerResponse.json({
            alarmName: yield* AlarmName,
            alarms: (result.MetricAlarms ?? []).map((a) => a.AlarmName),
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/describe-alarms-for-metric"
        ) {
          const result = yield* describeAlarmsForMetric({
            Namespace: METRIC_NAMESPACE,
            MetricName: METRIC_NAME,
            Statistic: "Sum",
            Period: 60,
          });
          return yield* HttpServerResponse.json({
            alarmName: yield* AlarmName,
            alarms: (result.MetricAlarms ?? []).map((a) => a.AlarmName),
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/describe-alarm-history"
        ) {
          const result = yield* describeAlarmHistory({
            AlarmName: yield* AlarmName,
            MaxRecords: 10,
          });
          return yield* HttpServerResponse.json({
            items: result.AlarmHistoryItems ?? [],
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/describe-alarm-contributors"
        ) {
          // Contributor data only exists for alarms with contributor-enabled
          // metric math; a plain metric alarm returns the typed
          // ValidationException (observed live: empty message) or
          // ResourceNotFoundException. Any outcome proves binding + IAM.
          const result = yield* describeAlarmContributors().pipe(
            Effect.map((r) => ({
              ok: true as const,
              contributors: r.AlarmContributors,
            })),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) =>
                Effect.succeed({
                  ok: false as const,
                  error: e._tag,
                }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/set-alarm-state") {
          const result = yield* setAlarmState({
            StateValue: "OK",
            StateReason: "alchemy-cloudwatch-bindings-test",
          });
          return yield* HttpServerResponse.json({ ok: true, result });
        }

        if (
          request.method === "POST" &&
          pathname === "/disable-alarm-actions"
        ) {
          const result = yield* disableAlarmActions();
          return yield* HttpServerResponse.json({ ok: true, result });
        }

        if (request.method === "POST" && pathname === "/enable-alarm-actions") {
          const result = yield* enableAlarmActions();
          return yield* HttpServerResponse.json({ ok: true, result });
        }

        if (
          request.method === "GET" &&
          pathname === "/list-tags-for-resource"
        ) {
          const result = yield* listTagsForResource();
          return yield* HttpServerResponse.json({
            tags: result.Tags ?? [],
          });
        }

        // ── Dashboards ─────────────────────────────────────────────────────

        if (request.method === "GET" && pathname === "/get-dashboard") {
          const result = yield* getDashboard();
          return yield* HttpServerResponse.json({
            dashboardName: yield* DashboardName,
            name: result.DashboardName,
            body: result.DashboardBody,
          });
        }

        if (request.method === "GET" && pathname === "/list-dashboards") {
          const result = yield* listDashboards();
          return yield* HttpServerResponse.json({
            dashboardName: yield* DashboardName,
            entries: (result.DashboardEntries ?? []).map(
              (e) => e.DashboardName,
            ),
          });
        }

        // ── Contributor Insights ───────────────────────────────────────────

        if (
          request.method === "GET" &&
          pathname === "/describe-insight-rules"
        ) {
          const result = yield* describeInsightRules();
          return yield* HttpServerResponse.json({
            ruleName: yield* RuleName,
            rules: (result.InsightRules ?? []).map((r) => r.Name),
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/get-insight-rule-report"
        ) {
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* getInsightRuleReport({
            StartTime: new Date(now - 3_600_000),
            EndTime: new Date(now),
            Period: 300,
          });
          return yield* HttpServerResponse.json({
            ok: true,
            aggregationStatistic: result.AggregationStatistic,
            contributors: result.Contributors ?? [],
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/disable-insight-rules"
        ) {
          const result = yield* disableInsightRules();
          return yield* HttpServerResponse.json({
            failures: result.Failures ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/enable-insight-rules") {
          const result = yield* enableInsightRules();
          return yield* HttpServerResponse.json({
            failures: result.Failures ?? [],
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/list-managed-insight-rules"
        ) {
          // Managed Contributor Insights rules only exist for specific AWS
          // resource types. We probe with the alarm ARN: a supported resource
          // returns ManagedRules, an unsupported one returns the typed
          // InvalidParameterValueException. Both outcomes prove binding + IAM.
          const result = yield* listManagedInsightRules({
            ResourceARN: yield* AlarmArn,
          }).pipe(
            Effect.map((r) => ({
              ok: true as const,
              rules: r.ManagedRules ?? [],
            })),
            Effect.catchTag("InvalidParameterValueException", () =>
              Effect.succeed({
                ok: false as const,
                error: "InvalidParameterValueException",
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        // ── Anomaly detectors ──────────────────────────────────────────────

        if (
          request.method === "GET" &&
          pathname === "/describe-anomaly-detectors"
        ) {
          const result = yield* describeAnomalyDetectors({
            Namespace: METRIC_NAMESPACE,
          });
          return yield* HttpServerResponse.json({
            detectors: result.AnomalyDetectors ?? [],
          });
        }

        // ── Alarm mute rules / metric streams (list-only; see test notes) ──

        if (request.method === "GET" && pathname === "/list-alarm-mute-rules") {
          const result = yield* listAlarmMuteRules();
          return yield* HttpServerResponse.json({
            summaries: result.AlarmMuteRuleSummaries ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/list-metric-streams") {
          const result = yield* listMetricStreams();
          return yield* HttpServerResponse.json({
            entries: result.Entries ?? [],
          });
        }

        return yield* HttpServerResponse.json(
          {
            error: "Not found",
            method: request.method,
            pathname,
          },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudWatch.DescribeAlarmContributorsHttp,
        CloudWatch.DescribeAlarmHistoryHttp,
        CloudWatch.DescribeAlarmsHttp,
        CloudWatch.DescribeAlarmsForMetricHttp,
        CloudWatch.DescribeAnomalyDetectorsHttp,
        CloudWatch.DescribeInsightRulesHttp,
        CloudWatch.DisableAlarmActionsHttp,
        CloudWatch.DisableInsightRulesHttp,
        CloudWatch.EnableAlarmActionsHttp,
        CloudWatch.EnableInsightRulesHttp,
        CloudWatch.GetDashboardHttp,
        CloudWatch.GetInsightRuleReportHttp,
        CloudWatch.GetMetricDataHttp,
        CloudWatch.GetMetricStatisticsHttp,
        CloudWatch.GetMetricWidgetImageHttp,
        CloudWatch.ListAlarmMuteRulesHttp,
        CloudWatch.ListDashboardsHttp,
        CloudWatch.ListManagedInsightRulesHttp,
        CloudWatch.ListMetricStreamsHttp,
        CloudWatch.ListMetricsHttp,
        CloudWatch.ListTagsForResourceHttp,
        CloudWatch.PutMetricDataHttp,
        CloudWatch.SetAlarmStateHttp,
      ),
    ),
  ),
);
