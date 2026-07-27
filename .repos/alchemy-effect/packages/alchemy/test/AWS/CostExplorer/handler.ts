import * as CostExplorer from "@/AWS/CostExplorer";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// A well-formed-but-nonexistent anomaly id — drives the typed error path for
// ProvideAnomalyFeedback (proving the monitor-scoped grant reaches the API).
const NONEXISTENT_ANOMALY_ID = "00000000-0000-0000-0000-000000000000";

/**
 * First day of the month `offset` months from now (UTC), as `yyyy-MM-dd`.
 * Cost Explorer time periods are half-open `[Start, End)` date intervals.
 */
const monthStart = (offset: number) =>
  Effect.sync(() => {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
    )
      .toISOString()
      .slice(0, 10);
  });

export class CostExplorerTestFunction extends Lambda.Function<Lambda.Function>()(
  "CostExplorerTestFunction",
) {}

export default CostExplorerTestFunction.make(
  {
    main,
    url: true,
    // Cost Explorer queries routinely take several seconds; the AWS default
    // 3s Lambda timeout is too tight.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // A CUSTOM monitor (the account allows only one DIMENSIONAL/SERVICE
    // monitor, which AnomalyMonitor.test.ts may own).
    const monitor = yield* CostExplorer.AnomalyMonitor("BindingsMonitor", {
      monitorType: "CUSTOM",
      monitorSpecification: {
        Tags: { Key: "alchemy-ce-bindings", Values: ["fixture"] },
      },
    });

    const category = yield* CostExplorer.CostCategory("BindingsCategory", {
      rules: [
        {
          Value: "fixture",
          Type: "REGULAR",
          Rule: {
            Tags: {
              Key: "alchemy-ce-bindings",
              Values: ["fixture"],
              MatchOptions: ["EQUALS"],
            },
          },
        },
      ],
      defaultValue: "other",
    });

    // --- account-level bindings ---
    const getCostAndUsage = yield* CostExplorer.GetCostAndUsage();
    const getCostAndUsageComparisons =
      yield* CostExplorer.GetCostAndUsageComparisons();
    const getCostAndUsageWithResources =
      yield* CostExplorer.GetCostAndUsageWithResources();
    const getCostComparisonDrivers =
      yield* CostExplorer.GetCostComparisonDrivers();
    const getApproximateUsageRecords =
      yield* CostExplorer.GetApproximateUsageRecords();
    const getCostForecast = yield* CostExplorer.GetCostForecast();
    const getUsageForecast = yield* CostExplorer.GetUsageForecast();
    const getDimensionValues = yield* CostExplorer.GetDimensionValues();
    const getTags = yield* CostExplorer.GetTags();
    const getCostCategories = yield* CostExplorer.GetCostCategories();
    const getReservationCoverage = yield* CostExplorer.GetReservationCoverage();
    const getReservationPurchaseRecommendation =
      yield* CostExplorer.GetReservationPurchaseRecommendation();
    const getReservationUtilization =
      yield* CostExplorer.GetReservationUtilization();
    const getRightsizingRecommendation =
      yield* CostExplorer.GetRightsizingRecommendation();
    const getSavingsPlansCoverage =
      yield* CostExplorer.GetSavingsPlansCoverage();
    const getSavingsPlansPurchaseRecommendation =
      yield* CostExplorer.GetSavingsPlansPurchaseRecommendation();
    const getSavingsPlanPurchaseRecommendationDetails =
      yield* CostExplorer.GetSavingsPlanPurchaseRecommendationDetails();
    const getSavingsPlansUtilization =
      yield* CostExplorer.GetSavingsPlansUtilization();
    const getSavingsPlansUtilizationDetails =
      yield* CostExplorer.GetSavingsPlansUtilizationDetails();
    const startSavingsPlansPurchaseRecommendationGeneration =
      yield* CostExplorer.StartSavingsPlansPurchaseRecommendationGeneration();
    const listSavingsPlansPurchaseRecommendationGeneration =
      yield* CostExplorer.ListSavingsPlansPurchaseRecommendationGeneration();
    const startCommitmentPurchaseAnalysis =
      yield* CostExplorer.StartCommitmentPurchaseAnalysis();
    const getCommitmentPurchaseAnalysis =
      yield* CostExplorer.GetCommitmentPurchaseAnalysis();
    const listCommitmentPurchaseAnalyses =
      yield* CostExplorer.ListCommitmentPurchaseAnalyses();
    const listCostAllocationTags = yield* CostExplorer.ListCostAllocationTags();
    const updateCostAllocationTagsStatus =
      yield* CostExplorer.UpdateCostAllocationTagsStatus();
    const startCostAllocationTagBackfill =
      yield* CostExplorer.StartCostAllocationTagBackfill();
    const listCostAllocationTagBackfillHistory =
      yield* CostExplorer.ListCostAllocationTagBackfillHistory();
    const provideAnomalyFeedback = yield* CostExplorer.ProvideAnomalyFeedback();

    // --- monitor-scoped bindings ---
    const getAnomalies = yield* CostExplorer.GetAnomalies(monitor);

    // --- cost-category-scoped bindings ---
    const listCostCategoryResourceAssociations =
      yield* CostExplorer.ListCostCategoryResourceAssociations(category);

    // --- anomaly event source ---
    // Anomalies cannot be forced in a test (they require days of real spend
    // data), so this exercises the deploy-time wiring: the EventBridge rule
    // on `aws.ce` / `Anomaly Detected` plus the Lambda invoke permission.
    yield* CostExplorer.consumeAnomalyEvents({}, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(
          `cost anomaly ${event.detail.anomalyId} on ${event.detail.dimensionValue}`,
        ),
      ),
    );

    const bound = {
      getCostAndUsage,
      getCostAndUsageComparisons,
      getCostAndUsageWithResources,
      getCostComparisonDrivers,
      getApproximateUsageRecords,
      getCostForecast,
      getUsageForecast,
      getDimensionValues,
      getTags,
      getCostCategories,
      getReservationCoverage,
      getReservationPurchaseRecommendation,
      getReservationUtilization,
      getRightsizingRecommendation,
      getSavingsPlansCoverage,
      getSavingsPlansPurchaseRecommendation,
      getSavingsPlanPurchaseRecommendationDetails,
      getSavingsPlansUtilization,
      getSavingsPlansUtilizationDetails,
      startSavingsPlansPurchaseRecommendationGeneration,
      listSavingsPlansPurchaseRecommendationGeneration,
      startCommitmentPurchaseAnalysis,
      getCommitmentPurchaseAnalysis,
      listCommitmentPurchaseAnalyses,
      listCostAllocationTags,
      updateCostAllocationTagsStatus,
      startCostAllocationTagBackfill,
      listCostAllocationTagBackfillHistory,
      getAnomalies,
      provideAnomalyFeedback,
      listCostCategoryResourceAssociations,
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

        if (request.method === "GET" && pathname === "/cost-and-usage") {
          const Start = yield* monthStart(-1);
          const End = yield* monthStart(0);
          const result = yield* getCostAndUsage({
            TimePeriod: { Start, End },
            Granularity: "MONTHLY",
            Metrics: ["UnblendedCost"],
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              results: (r.ResultsByTime ?? []).length,
              amount:
                r.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount ?? null,
            })),
            Effect.catchTag("DataUnavailableException", (e) =>
              Effect.succeed({ tag: e._tag, results: 0, amount: null }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/dimension-values") {
          const Start = yield* monthStart(-1);
          const End = yield* monthStart(0);
          const result = yield* getDimensionValues({
            TimePeriod: { Start, End },
            Dimension: "SERVICE",
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.DimensionValues ?? []).length,
            })),
            Effect.catchTag("DataUnavailableException", (e) =>
              Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/tag-keys") {
          const Start = yield* monthStart(-1);
          const End = yield* monthStart(0);
          const result = yield* getTags({ TimePeriod: { Start, End } }).pipe(
            Effect.map((r) => ({ tag: "Ok", count: (r.Tags ?? []).length })),
            Effect.catchTag("DataUnavailableException", (e) =>
              Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/cost-categories") {
          const Start = yield* monthStart(-1);
          const End = yield* monthStart(0);
          const result = yield* getCostCategories({
            TimePeriod: { Start, End },
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              names: r.CostCategoryNames ?? [],
            })),
            Effect.catchTag("DataUnavailableException", (e) =>
              Effect.succeed({ tag: e._tag, names: [] as string[] }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/forecast") {
          const Start = yield* monthStart(1);
          const End = yield* monthStart(2);
          const result = yield* getCostForecast({
            TimePeriod: { Start, End },
            Metric: "UNBLENDED_COST",
            Granularity: "MONTHLY",
          }).pipe(
            Effect.map((r) => ({ tag: "Ok", amount: r.Total?.Amount ?? null })),
            Effect.catchTag("DataUnavailableException", (e) =>
              Effect.succeed({ tag: e._tag, amount: null }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/approximate-usage") {
          // SERVICE-dimension estimates only support HOURLY granularity —
          // DAILY is resource-level only and fails with ValidationException
          // ("The estimation data cannot be generated for your input
          // combination", verified by probe).
          const result = yield* getApproximateUsageRecords({
            Granularity: "HOURLY",
            ApproximationDimension: "SERVICE",
          }).pipe(
            Effect.map((r) => ({ tag: "Ok", total: r.TotalRecords ?? 0 })),
            Effect.catchTag("DataUnavailableException", (e) =>
              Effect.succeed({ tag: e._tag, total: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/rightsizing") {
          // Rightsizing recommendations are an opt-in Cost Explorer
          // preference on the payer account. An account without the opt-in
          // rejects with RightsizingRecommendationNotEnabled — the
          // AccessDeniedException "opt-in only feature" rejection (verified
          // by probe) patched into distilled as a specific typed tag. A
          // genuine IAM gap still surfaces as AccessDeniedException and
          // fails the route.
          const result = yield* getRightsizingRecommendation({
            Service: "AmazonEC2",
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.RightsizingRecommendations ?? []).length,
            })),
            Effect.catchTag("RightsizingRecommendationNotEnabled", (e) =>
              Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/reservation-recommendation"
        ) {
          const result = yield* getReservationPurchaseRecommendation({
            Service: "Amazon Elastic Compute Cloud - Compute",
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.Recommendations ?? []).length,
            })),
            Effect.catchTag("DataUnavailableException", (e) =>
              Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/savings-plans-utilization"
        ) {
          const Start = yield* monthStart(-1);
          const End = yield* monthStart(0);
          const result = yield* getSavingsPlansUtilization({
            TimePeriod: { Start, End },
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              utilization: r.Total?.Utilization?.UtilizationPercentage ?? null,
            })),
            Effect.catchTag("DataUnavailableException", (e) =>
              Effect.succeed({ tag: e._tag, utilization: null }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/recommendation-generations"
        ) {
          const result =
            yield* listSavingsPlansPurchaseRecommendationGeneration().pipe(
              Effect.map((r) => ({
                tag: "Ok",
                count: (r.GenerationSummaryList ?? []).length,
              })),
              Effect.catchTag("DataUnavailableException", (e) =>
                Effect.succeed({ tag: e._tag, count: 0 }),
              ),
            );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/commitment-analyses") {
          const result = yield* listCommitmentPurchaseAnalyses().pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: (r.AnalysisSummaryList ?? []).length,
            })),
            Effect.catchTag("DataUnavailableException", (e) =>
              Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/allocation-tags") {
          const result = yield* listCostAllocationTags({ MaxResults: 100 });
          return yield* HttpServerResponse.json({
            count: (result.CostAllocationTags ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/backfill-history") {
          const result = yield* listCostAllocationTagBackfillHistory();
          return yield* HttpServerResponse.json({
            count: (result.BackfillRequests ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/anomalies") {
          const Start = yield* monthStart(-2);
          const result = yield* getAnomalies({
            DateInterval: { StartDate: Start },
          });
          return yield* HttpServerResponse.json({
            count: (result.Anomalies ?? []).length,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/anomaly-feedback-invalid"
        ) {
          // Exercises the account-level grant + the typed error path — the
          // nonexistent anomaly id must surface the typed ValidationException
          // ("Feedback is submitted for an invalid anomaly", verified by
          // probe). An IAM gap would surface AccessDeniedException and 500
          // this route instead.
          const result = yield* provideAnomalyFeedback({
            AnomalyId: NONEXISTENT_ANOMALY_ID,
            Feedback: "PLANNED_ACTIVITY",
          }).pipe(
            Effect.map(() => "Provided"),
            Effect.catchTag("ValidationException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (request.method === "GET" && pathname === "/category-associations") {
          const result = yield* listCostCategoryResourceAssociations();
          return yield* HttpServerResponse.json({
            count: (result.CostCategoryResourceAssociations ?? []).length,
          });
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
        CostExplorer.GetCostAndUsageHttp,
        CostExplorer.GetCostAndUsageComparisonsHttp,
        CostExplorer.GetCostAndUsageWithResourcesHttp,
        CostExplorer.GetCostComparisonDriversHttp,
        CostExplorer.GetApproximateUsageRecordsHttp,
        CostExplorer.GetCostForecastHttp,
        CostExplorer.GetUsageForecastHttp,
        CostExplorer.GetDimensionValuesHttp,
        CostExplorer.GetTagsHttp,
        CostExplorer.GetCostCategoriesHttp,
        CostExplorer.GetReservationCoverageHttp,
        CostExplorer.GetReservationPurchaseRecommendationHttp,
        CostExplorer.GetReservationUtilizationHttp,
        CostExplorer.GetRightsizingRecommendationHttp,
        CostExplorer.GetSavingsPlansCoverageHttp,
        CostExplorer.GetSavingsPlansPurchaseRecommendationHttp,
        CostExplorer.GetSavingsPlanPurchaseRecommendationDetailsHttp,
        CostExplorer.GetSavingsPlansUtilizationHttp,
        CostExplorer.GetSavingsPlansUtilizationDetailsHttp,
        CostExplorer.StartSavingsPlansPurchaseRecommendationGenerationHttp,
        CostExplorer.ListSavingsPlansPurchaseRecommendationGenerationHttp,
        CostExplorer.StartCommitmentPurchaseAnalysisHttp,
        CostExplorer.GetCommitmentPurchaseAnalysisHttp,
        CostExplorer.ListCommitmentPurchaseAnalysesHttp,
        CostExplorer.ListCostAllocationTagsHttp,
        CostExplorer.UpdateCostAllocationTagsStatusHttp,
        CostExplorer.StartCostAllocationTagBackfillHttp,
        CostExplorer.ListCostAllocationTagBackfillHistoryHttp,
        CostExplorer.GetAnomaliesHttp,
        CostExplorer.ProvideAnomalyFeedbackHttp,
        CostExplorer.ListCostCategoryResourceAssociationsHttp,
      ),
    ),
  ),
);
