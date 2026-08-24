import * as Lambda from "@/AWS/Lambda";
import * as ObservabilityAdmin from "@/AWS/ObservabilityAdmin";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class ObservabilityAdminBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "ObservabilityAdminBindingsFunction",
) {}

export default ObservabilityAdminBindingsFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // A short-lived rule exercising the rule-scoped grant + name injection.
    // It exists for well under the ~24h AWS Config discovery window, so it
    // never actually configures flow logs. (Requires the account to be
    // onboarded to telemetry config; the test's beforeAll ensures that
    // out-of-band.)
    const rule = yield* ObservabilityAdmin.TelemetryRule("BindingsRule", {
      resourceType: "AWS::EC2::VPC",
      telemetryType: "Logs",
      telemetrySourceTypes: ["VPC_FLOW_LOGS"],
      destinationConfiguration: {
        DestinationType: "cloud-watch-logs",
        Retention: "30 days",
      },
    });

    const bound = {
      listResourceTelemetry: yield* ObservabilityAdmin.ListResourceTelemetry(),
      getTelemetryEvaluationStatus:
        yield* ObservabilityAdmin.GetTelemetryEvaluationStatus(),
      getTelemetryEnrichmentStatus:
        yield* ObservabilityAdmin.GetTelemetryEnrichmentStatus(),
      listTelemetryRules: yield* ObservabilityAdmin.ListTelemetryRules(),
      getTelemetryRule: yield* ObservabilityAdmin.GetTelemetryRule(rule),
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

        // Account-level telemetry audit data plane. Right after onboarding
        // the audit backend may answer with a service-side error until
        // AWS Config discovery warms up (documented as up to 24h), so
        // report the typed tag instead of dying — an IAM gap would surface
        // as AccessDeniedException, which the test rejects.
        if (request.method === "GET" && pathname === "/resource-telemetry") {
          const result = yield* Effect.result(
            bound.listResourceTelemetry({
              ResourceTypes: ["AWS::EC2::VPC"],
              MaxResults: 10,
            }),
          );
          return yield* HttpServerResponse.json(
            Result.isSuccess(result)
              ? {
                  tag: "ok",
                  count: (result.success.TelemetryConfigurations ?? []).length,
                }
              : { tag: result.failure._tag, error: String(result.failure) },
          );
        }

        // Account onboarding status.
        if (request.method === "GET" && pathname === "/evaluation-status") {
          const { Status } = yield* bound.getTelemetryEvaluationStatus();
          return yield* HttpServerResponse.json({
            status: Status ?? "NOT_STARTED",
          });
        }

        // Enrichment status — a never-onboarded account answers with a typed
        // ResourceNotFoundException, which still proves the grant.
        if (request.method === "GET" && pathname === "/enrichment-status") {
          const status = yield* bound.getTelemetryEnrichmentStatus().pipe(
            Effect.map((r) => r.Status ?? "Stopped"),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed("NotOnboarded"),
            ),
          );
          return yield* HttpServerResponse.json({ status });
        }

        // Account-level rule enumeration — must include the bound rule.
        if (request.method === "GET" && pathname === "/rules") {
          const { TelemetryRuleSummaries } = yield* bound.listTelemetryRules();
          return yield* HttpServerResponse.json({
            names: (TelemetryRuleSummaries ?? []).flatMap((summary) =>
              summary.RuleName === undefined ? [] : [summary.RuleName],
            ),
          });
        }

        // Rule-scoped read — the rule name is injected from the binding.
        if (request.method === "GET" && pathname === "/rule") {
          const got = yield* bound.getTelemetryRule();
          return yield* HttpServerResponse.json({
            ruleName: got.RuleName,
            telemetryType: got.TelemetryRule?.TelemetryType,
            retentionInDays:
              got.TelemetryRule?.DestinationConfiguration?.RetentionInDays,
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
        ObservabilityAdmin.ListResourceTelemetryHttp,
        ObservabilityAdmin.GetTelemetryEvaluationStatusHttp,
        ObservabilityAdmin.GetTelemetryEnrichmentStatusHttp,
        ObservabilityAdmin.ListTelemetryRulesHttp,
        ObservabilityAdmin.GetTelemetryRuleHttp,
      ),
    ),
  ),
);
