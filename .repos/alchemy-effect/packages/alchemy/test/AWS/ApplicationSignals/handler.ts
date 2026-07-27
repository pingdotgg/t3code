import * as ApplicationSignals from "@/AWS/ApplicationSignals";
import * as Lambda from "@/AWS/Lambda";
import type * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// KeyAttributes of a service that does NOT exist — the discovery reads are
// account-scoped time-range queries that return well-formed empty results
// for unknown services, which is exactly what a fresh test account has.
const PROBE_KEY_ATTRIBUTES = {
  Type: "Service",
  Name: "alchemy-test-appsignals-bindings-probe",
  Environment: "alchemy-test-env",
};

// A period-based SLI over an arbitrary CloudWatch metric (the metric does
// not need to exist for the SLO to be valid).
const SLI_CONFIG: appsignals.ServiceLevelIndicatorConfig = {
  SliMetricConfig: {
    MetricDataQueries: [
      {
        Id: "m1",
        MetricStat: {
          Metric: {
            Namespace: "Alchemy/Test",
            MetricName: "AppSignalsBindingsLatency",
            Dimensions: [{ Name: "Fixture", Value: "bindings" }],
          },
          Period: 60,
          Stat: "Average",
        },
        ReturnData: true,
      },
    ],
  },
  MetricThreshold: 2000,
  ComparisonOperator: "LessThanOrEqualTo",
};

export class ApplicationSignalsTestFunction extends Lambda.Function<Lambda.Function>()(
  "ApplicationSignalsTestFunction",
) {}

export default ApplicationSignalsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const slo = yield* ApplicationSignals.ServiceLevelObjective("BindingsSlo", {
      description: "alchemy application-signals bindings fixture slo",
      sliConfig: SLI_CONFIG,
      goal: {
        Interval: { RollingInterval: { DurationUnit: "DAY", Duration: 7 } },
        AttainmentGoal: 99,
        WarningThreshold: 50,
      },
    });
    const probe = yield* ApplicationSignals.InstrumentationConfiguration(
      "BindingsProbe",
      {
        instrumentationType: "PROBE",
        service: "alchemy-test-appsignals-bindings-ic",
        environment: "alchemy-test-env",
        signalType: "SNAPSHOT",
        location: {
          Language: "Python",
          CodeUnit: "app.main",
          MethodName: "handler",
          FilePath: "app/main.py",
          LineNumber: 10,
        },
        captureConfiguration: {
          CaptureLocals: ["x"],
          CaptureLimits: { MaxHits: 1 },
        },
      },
    );

    // --- account-level discovery bindings ---
    const listServices = yield* ApplicationSignals.ListServices();
    const getService = yield* ApplicationSignals.GetService();
    const listServiceDependencies =
      yield* ApplicationSignals.ListServiceDependencies();
    const listServiceDependents =
      yield* ApplicationSignals.ListServiceDependents();
    const listServiceOperations =
      yield* ApplicationSignals.ListServiceOperations();
    const listServiceStates = yield* ApplicationSignals.ListServiceStates();
    const listEntityEvents = yield* ApplicationSignals.ListEntityEvents();
    const listAuditFindings = yield* ApplicationSignals.ListAuditFindings();

    // --- SLO-scoped bindings ---
    const listSlos = yield* ApplicationSignals.ListServiceLevelObjectives();
    const getSlo = yield* ApplicationSignals.GetServiceLevelObjective(slo);
    const getBudgetReport =
      yield* ApplicationSignals.BatchGetServiceLevelObjectiveBudgetReport(slo);
    const listExclusionWindows =
      yield* ApplicationSignals.ListServiceLevelObjectiveExclusionWindows(slo);
    const updateExclusionWindows =
      yield* ApplicationSignals.BatchUpdateExclusionWindows(slo);

    // --- instrumentation-configuration-scoped binding ---
    const getInstrumentationStatus =
      yield* ApplicationSignals.GetInstrumentationConfigurationStatus(probe);

    const bound = {
      listServices,
      getService,
      listServiceDependencies,
      listServiceDependents,
      listServiceOperations,
      listServiceStates,
      listEntityEvents,
      listAuditFindings,
      listSlos,
      getSlo,
      getBudgetReport,
      listExclusionWindows,
      updateExclusionWindows,
      getInstrumentationStatus,
    };

    const window = () => {
      const EndTime = new Date();
      const StartTime = new Date(EndTime.getTime() - 3600_000);
      return { StartTime, EndTime };
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

        if (request.method === "GET" && pathname === "/services") {
          const result = yield* listServices(window());
          return yield* HttpServerResponse.json({
            count: result.ServiceSummaries.length,
          });
        }

        if (request.method === "GET" && pathname === "/service") {
          const result = yield* getService({
            ...window(),
            KeyAttributes: PROBE_KEY_ATTRIBUTES,
          });
          // An unknown service returns an empty Service object.
          return yield* HttpServerResponse.json({
            discovered: result.Service.KeyAttributes !== undefined,
          });
        }

        if (request.method === "GET" && pathname === "/dependencies") {
          const result = yield* listServiceDependencies({
            ...window(),
            KeyAttributes: PROBE_KEY_ATTRIBUTES,
          });
          return yield* HttpServerResponse.json({
            count: result.ServiceDependencies.length,
          });
        }

        if (request.method === "GET" && pathname === "/dependents") {
          const result = yield* listServiceDependents({
            ...window(),
            KeyAttributes: PROBE_KEY_ATTRIBUTES,
          });
          return yield* HttpServerResponse.json({
            count: result.ServiceDependents.length,
          });
        }

        if (request.method === "GET" && pathname === "/operations") {
          const result = yield* listServiceOperations({
            ...window(),
            KeyAttributes: PROBE_KEY_ATTRIBUTES,
          });
          return yield* HttpServerResponse.json({
            count: result.ServiceOperations.length,
          });
        }

        if (request.method === "GET" && pathname === "/states") {
          const result = yield* listServiceStates(window());
          return yield* HttpServerResponse.json({
            count: result.ServiceStates.length,
          });
        }

        if (request.method === "GET" && pathname === "/entity-events") {
          const result = yield* listEntityEvents({
            ...window(),
            Entity: PROBE_KEY_ATTRIBUTES,
          });
          return yield* HttpServerResponse.json({
            count: result.ChangeEvents.length,
          });
        }

        if (request.method === "GET" && pathname === "/audit-findings") {
          const result = yield* listAuditFindings({
            ...window(),
            AuditTargets: [
              { Type: "service", Data: { Service: PROBE_KEY_ATTRIBUTES } },
            ],
          });
          return yield* HttpServerResponse.json({
            count: result.AuditFindings.length,
          });
        }

        if (request.method === "GET" && pathname === "/slos") {
          // The fixture SLO must be among the account's SLOs.
          const result = yield* listSlos({});
          const summaries = result.SloSummaries ?? [];
          return yield* HttpServerResponse.json({
            count: summaries.length,
            names: summaries.map((summary) => summary.Name),
          });
        }

        if (request.method === "GET" && pathname === "/slo") {
          const result = yield* getSlo();
          return yield* HttpServerResponse.json({
            name: result.Slo.Name,
            arn: result.Slo.Arn,
            attainmentGoal: result.Slo.Goal.AttainmentGoal,
          });
        }

        if (request.method === "GET" && pathname === "/budget-report") {
          const result = yield* getBudgetReport({ Timestamp: new Date() });
          return yield* HttpServerResponse.json({
            reports: result.Reports.length,
            errors: result.Errors.length,
            budgetStatus: result.Reports[0]?.BudgetStatus ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/exclusion-windows") {
          const result = yield* listExclusionWindows();
          return yield* HttpServerResponse.json({
            count: result.ExclusionWindows.length,
          });
        }

        if (request.method === "POST" && pathname === "/exclusion-windows") {
          // Add a maintenance window, observe it, then remove it again so
          // the fixture SLO stays clean between requests.
          const exclusionWindow: appsignals.ExclusionWindow = {
            StartTime: new Date(Date.now() + 3600_000),
            Window: { DurationUnit: "HOUR", Duration: 1 },
            Reason: "alchemy bindings test",
          };
          const added = yield* updateExclusionWindows({
            AddExclusionWindows: [exclusionWindow],
          });
          const afterAdd = yield* listExclusionWindows();
          const removed = yield* updateExclusionWindows({
            RemoveExclusionWindows: [exclusionWindow],
          });
          const afterRemove = yield* listExclusionWindows();
          return yield* HttpServerResponse.json({
            addErrors: added.Errors.length,
            afterAdd: afterAdd.ExclusionWindows.length,
            removeErrors: removed.Errors.length,
            afterRemove: afterRemove.ExclusionWindows.length,
          });
        }

        if (request.method === "GET" && pathname === "/ic-status") {
          // No SDK agent is attached to the synthetic service, so the
          // status history is empty — the call itself proves the identity
          // injection and the IAM grant.
          const result = yield* getInstrumentationStatus();
          return yield* HttpServerResponse.json({
            events: result.Events.length,
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
        ApplicationSignals.ListServicesHttp,
        ApplicationSignals.GetServiceHttp,
        ApplicationSignals.ListServiceDependenciesHttp,
        ApplicationSignals.ListServiceDependentsHttp,
        ApplicationSignals.ListServiceOperationsHttp,
        ApplicationSignals.ListServiceStatesHttp,
        ApplicationSignals.ListEntityEventsHttp,
        ApplicationSignals.ListAuditFindingsHttp,
        ApplicationSignals.ListServiceLevelObjectivesHttp,
        ApplicationSignals.GetServiceLevelObjectiveHttp,
        ApplicationSignals.BatchGetServiceLevelObjectiveBudgetReportHttp,
        ApplicationSignals.ListServiceLevelObjectiveExclusionWindowsHttp,
        ApplicationSignals.BatchUpdateExclusionWindowsHttp,
        ApplicationSignals.GetInstrumentationConfigurationStatusHttp,
      ),
    ),
  ),
);
