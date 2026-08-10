import * as DevOpsGuru from "@/AWS/DevOpsGuru";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class DevOpsGuruTestFunction extends Lambda.Function<Lambda.Function>()(
  "DevOpsGuruTestFunction",
) {}

export default DevOpsGuruTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Event source: subscribe the host to insight lifecycle events. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* DevOpsGuru.consumeInsightEvents(
      { kinds: ["new-insight", "severity-upgraded"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `devops-guru insight: ${event.detail.insightId} (${event.detail.insightSeverity})`,
          ),
        ),
    );

    // Every account-level capability the service exposes — the init phase
    // registers the IAM grant for each; a representative subset is
    // exercised over HTTP routes below.
    const bound = {
      describeAccountHealth: yield* DevOpsGuru.DescribeAccountHealth(),
      describeAccountOverview: yield* DevOpsGuru.DescribeAccountOverview(),
      describeAnomaly: yield* DevOpsGuru.DescribeAnomaly(),
      describeFeedback: yield* DevOpsGuru.DescribeFeedback(),
      describeInsight: yield* DevOpsGuru.DescribeInsight(),
      describeOrganizationHealth:
        yield* DevOpsGuru.DescribeOrganizationHealth(),
      describeOrganizationOverview:
        yield* DevOpsGuru.DescribeOrganizationOverview(),
      describeOrganizationResourceCollectionHealth:
        yield* DevOpsGuru.DescribeOrganizationResourceCollectionHealth(),
      describeResourceCollectionHealth:
        yield* DevOpsGuru.DescribeResourceCollectionHealth(),
      getCostEstimation: yield* DevOpsGuru.GetCostEstimation(),
      startCostEstimation: yield* DevOpsGuru.StartCostEstimation(),
      listAnomaliesForInsight: yield* DevOpsGuru.ListAnomaliesForInsight(),
      listAnomalousLogGroups: yield* DevOpsGuru.ListAnomalousLogGroups(),
      listEvents: yield* DevOpsGuru.ListEvents(),
      listInsights: yield* DevOpsGuru.ListInsights(),
      listMonitoredResources: yield* DevOpsGuru.ListMonitoredResources(),
      listOrganizationInsights: yield* DevOpsGuru.ListOrganizationInsights(),
      listRecommendations: yield* DevOpsGuru.ListRecommendations(),
      putFeedback: yield* DevOpsGuru.PutFeedback(),
      searchInsights: yield* DevOpsGuru.SearchInsights(),
      searchOrganizationInsights:
        yield* DevOpsGuru.SearchOrganizationInsights(),
      deleteInsight: yield* DevOpsGuru.DeleteInsight(),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Account health counters — works even before DevOps Guru is
        // configured (returns zeroes).
        if (request.method === "GET" && pathname === "/health") {
          const health = yield* bound.describeAccountHealth();
          return yield* HttpServerResponse.json({
            openReactiveInsights: health.OpenReactiveInsights,
            openProactiveInsights: health.OpenProactiveInsights,
            metricsAnalyzed: health.MetricsAnalyzed,
          });
        }

        // Account overview for the trailing 24 hours.
        if (request.method === "GET" && pathname === "/overview") {
          const overview = yield* bound.describeAccountOverview({
            FromTime: new Date(Date.now() - 24 * 3600_000),
          });
          return yield* HttpServerResponse.json({
            reactiveInsights: overview.ReactiveInsights,
            proactiveInsights: overview.ProactiveInsights,
          });
        }

        // Ongoing reactive insights.
        if (request.method === "GET" && pathname === "/insights") {
          const { ReactiveInsights } = yield* bound.listInsights({
            StatusFilter: { Ongoing: { Type: "REACTIVE" } },
          });
          return yield* HttpServerResponse.json({
            count: (ReactiveInsights ?? []).length,
          });
        }

        // Search reactive insights in the trailing 24 hours. The service
        // requires ToTime even though the SDK marks it optional.
        if (request.method === "GET" && pathname === "/search") {
          const { ReactiveInsights } = yield* bound.searchInsights({
            Type: "REACTIVE",
            StartTimeRange: {
              FromTime: new Date(Date.now() - 24 * 3600_000),
              ToTime: new Date(),
            },
          });
          return yield* HttpServerResponse.json({
            count: (ReactiveInsights ?? []).length,
          });
        }

        // Per-stack health of the analyzed CloudFormation coverage.
        if (request.method === "GET" && pathname === "/collection-health") {
          const page = yield* bound.describeResourceCollectionHealth({
            ResourceCollectionType: "AWS_CLOUD_FORMATION",
          });
          return yield* HttpServerResponse.json({
            stacks: (page.CloudFormation ?? []).length,
          });
        }

        // Monitored resources — a typed not-found means DevOps Guru has no
        // resource collection configured; report zero coverage.
        if (request.method === "GET" && pathname === "/monitored") {
          const count = yield* bound.listMonitoredResources().pipe(
            Effect.map(
              ({ MonitoredResourceIdentifiers }) =>
                MonitoredResourceIdentifiers.length,
            ),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(0),
            ),
          );
          return yield* HttpServerResponse.json({ count });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        DevOpsGuru.DescribeAccountHealthHttp,
        DevOpsGuru.DescribeAccountOverviewHttp,
        DevOpsGuru.DescribeAnomalyHttp,
        DevOpsGuru.DescribeFeedbackHttp,
        DevOpsGuru.DescribeInsightHttp,
        DevOpsGuru.DescribeOrganizationHealthHttp,
        DevOpsGuru.DescribeOrganizationOverviewHttp,
        DevOpsGuru.DescribeOrganizationResourceCollectionHealthHttp,
        DevOpsGuru.DescribeResourceCollectionHealthHttp,
        DevOpsGuru.GetCostEstimationHttp,
        DevOpsGuru.StartCostEstimationHttp,
        DevOpsGuru.ListAnomaliesForInsightHttp,
        DevOpsGuru.ListAnomalousLogGroupsHttp,
        DevOpsGuru.ListEventsHttp,
        DevOpsGuru.ListInsightsHttp,
        DevOpsGuru.ListMonitoredResourcesHttp,
        DevOpsGuru.ListOrganizationInsightsHttp,
        DevOpsGuru.ListRecommendationsHttp,
        DevOpsGuru.PutFeedbackHttp,
        DevOpsGuru.SearchInsightsHttp,
        DevOpsGuru.SearchOrganizationInsightsHttp,
        DevOpsGuru.DeleteInsightHttp,
      ),
    ),
  ),
);
