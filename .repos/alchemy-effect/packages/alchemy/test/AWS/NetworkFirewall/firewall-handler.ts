import { Subnet, Vpc } from "@/AWS/EC2";
import * as Lambda from "@/AWS/Lambda";
import * as NetworkFirewall from "@/AWS/NetworkFirewall";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "firewall-handler.ts");

export class NetworkFirewallFirewallBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "NetworkFirewallFirewallBindingsFunction",
) {}

/**
 * Firewall-scoped bindings fixture. A firewall takes ~5-10 minutes to
 * provision its endpoints, so this fixture is only deployed by the
 * `AWS_TEST_NETWORKFIREWALL=1`-gated tests in `FirewallBindings.test.ts`.
 */
export default NetworkFirewallFirewallBindingsFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    const vpc = yield* Vpc("BindingsVpc", {
      cidrBlock: "10.78.0.0/16",
      tags: { fixture: "nfw-bindings" },
    });
    const subnet = yield* Subnet("BindingsFirewallSubnet", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.78.1.0/24",
      tags: { fixture: "nfw-bindings" },
    });
    const policy = yield* NetworkFirewall.FirewallPolicy("BindingsFwPolicy", {
      firewallPolicy: {
        StatelessDefaultActions: ["aws:pass"],
        StatelessFragmentDefaultActions: ["aws:pass"],
      },
    });
    const firewall = yield* NetworkFirewall.Firewall("BindingsFirewall", {
      firewallPolicyArn: policy.firewallPolicyArn,
      vpcId: vpc.vpcId,
      subnetMappings: [{ SubnetId: subnet.subnetId }],
      tags: { fixture: "nfw-bindings" },
    });

    const bound = {
      describeFirewall: yield* NetworkFirewall.DescribeFirewall(firewall),
      startFlowCapture: yield* NetworkFirewall.StartFlowCapture(firewall),
      startFlowFlush: yield* NetworkFirewall.StartFlowFlush(firewall),
      describeFlowOperation:
        yield* NetworkFirewall.DescribeFlowOperation(firewall),
      listFlowOperations: yield* NetworkFirewall.ListFlowOperations(firewall),
      listFlowOperationResults:
        yield* NetworkFirewall.ListFlowOperationResults(firewall),
      startAnalysisReport: yield* NetworkFirewall.StartAnalysisReport(firewall),
      listAnalysisReports: yield* NetworkFirewall.ListAnalysisReports(firewall),
      getAnalysisReportResults:
        yield* NetworkFirewall.GetAnalysisReportResults(firewall),
    };

    // A narrow filter so the capture/flush stays tiny.
    const flowFilters = [
      { SourceAddress: { AddressDefinition: "10.78.1.10/32" } },
    ];

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

        // Firewall-scoped describe — the firewall ARN is injected.
        if (request.method === "GET" && pathname === "/firewall") {
          const response = yield* bound.describeFirewall();
          return yield* HttpServerResponse.json({
            status: response.FirewallStatus?.Status,
            endpointCount: Object.keys(
              response.FirewallStatus?.SyncStates ?? {},
            ).length,
          });
        }

        // Full flow-operation loop: start a capture, poll (bounded) until
        // terminal, then read it back through the list interfaces. Each
        // step reports its typed failure so a single grant gap is
        // diagnosable from the JSON instead of a generic 500.
        if (request.method === "GET" && pathname === "/flow") {
          const started = yield* Effect.result(
            bound.startFlowCapture({ FlowFilters: flowFilters }),
          );
          if (Result.isFailure(started)) {
            return yield* HttpServerResponse.json({
              step: "startFlowCapture",
              tag: started.failure._tag,
              error: String(started.failure),
            });
          }
          const FlowOperationId = started.success.FlowOperationId!;
          const polled = yield* Effect.result(
            bound.describeFlowOperation({ FlowOperationId }).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (r): boolean => r.FlowOperationStatus !== "IN_PROGRESS",
                times: 20,
              }),
            ),
          );
          if (Result.isFailure(polled)) {
            return yield* HttpServerResponse.json({
              step: "describeFlowOperation",
              tag: polled.failure._tag,
              error: String(polled.failure),
            });
          }
          const listed = yield* Effect.result(
            bound.listFlowOperations({ FlowOperationType: "FLOW_CAPTURE" }),
          );
          if (Result.isFailure(listed)) {
            return yield* HttpServerResponse.json({
              step: "listFlowOperations",
              tag: listed.failure._tag,
              error: String(listed.failure),
            });
          }
          const results = yield* Effect.result(
            bound.listFlowOperationResults({ FlowOperationId }),
          );
          if (Result.isFailure(results)) {
            return yield* HttpServerResponse.json({
              step: "listFlowOperationResults",
              tag: results.failure._tag,
              error: String(results.failure),
            });
          }
          return yield* HttpServerResponse.json({
            step: "ok",
            flowOperationId: FlowOperationId,
            status: polled.success.FlowOperationStatus,
            operations: (listed.success.FlowOperations ?? []).length,
            flows: (results.success.Flows ?? []).length,
          });
        }

        // Flush — success or any typed rejection proves the grant.
        if (request.method === "GET" && pathname === "/flush") {
          const tag = yield* bound
            .startFlowFlush({ FlowFilters: flowFilters })
            .pipe(
              Effect.map(() => "ok"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            );
          return yield* HttpServerResponse.json({ tag });
        }

        // Analysis-report interface. The fixture firewall has no analysis
        // types enabled, so StartAnalysisReport and a bogus
        // GetAnalysisReportResults round-trip to typed rejections (an IAM
        // gap would surface AccessDeniedException instead); the list is a
        // real (empty) read.
        if (request.method === "GET" && pathname === "/analysis") {
          const startTag = yield* bound
            .startAnalysisReport({ AnalysisType: "TLS_SNI" })
            .pipe(
              Effect.map(() => "ok"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            );
          const listed = yield* Effect.result(bound.listAnalysisReports());
          if (Result.isFailure(listed)) {
            return yield* HttpServerResponse.json({
              step: "listAnalysisReports",
              tag: listed.failure._tag,
              error: String(listed.failure),
            });
          }
          const getTag = yield* bound
            .getAnalysisReportResults({
              AnalysisReportId: "alchemy-nonexistent-analysis-report-id",
            })
            .pipe(
              Effect.map(() => "ok"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            );
          return yield* HttpServerResponse.json({
            step: "ok",
            startTag,
            reports: (listed.success.AnalysisReports ?? []).length,
            getTag,
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
        NetworkFirewall.DescribeFirewallHttp,
        NetworkFirewall.StartFlowCaptureHttp,
        NetworkFirewall.StartFlowFlushHttp,
        NetworkFirewall.DescribeFlowOperationHttp,
        NetworkFirewall.ListFlowOperationsHttp,
        NetworkFirewall.ListFlowOperationResultsHttp,
        NetworkFirewall.StartAnalysisReportHttp,
        NetworkFirewall.ListAnalysisReportsHttp,
        NetworkFirewall.GetAnalysisReportResultsHttp,
      ),
    ),
  ),
);
