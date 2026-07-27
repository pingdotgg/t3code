import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import NetworkFirewallFirewallBindingsFunctionLive, {
  NetworkFirewallFirewallBindingsFunction,
} from "./firewall-handler";

// A firewall takes ~5-10 minutes to provision its endpoints (and a similar
// window to deprovision), so the firewall-scoped bindings fixture is gated
// behind AWS_TEST_NETWORKFIREWALL=1 — same gate as the Firewall lifecycle
// test.
const gated = !process.env.AWS_TEST_NETWORKFIREWALL;

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "NetworkFirewallFirewallBindings",
);

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

const getJson = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

describe.sequential("NetworkFirewall Firewall Bindings", () => {
  beforeAll(
    gated
      ? Effect.void
      : Effect.gen(function* () {
          yield* Effect.logInfo(
            "NetworkFirewall firewall-bindings setup: destroying previous resources",
          );
          yield* sharedStack.destroy();

          yield* Effect.logInfo(
            "NetworkFirewall firewall-bindings setup: deploying fixture (firewall provisioning takes 5-10 minutes)",
          );
          const attrs = yield* sharedStack.deploy(
            Effect.gen(function* () {
              return yield* NetworkFirewallFirewallBindingsFunction;
            }).pipe(
              Effect.provide(NetworkFirewallFirewallBindingsFunctionLive),
            ),
          );

          expect(attrs.functionUrl).toBeTruthy();
          baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

          yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? Effect.succeed(response)
                : Effect.fail(
                    new Error(`Function not ready: ${response.status}`),
                  ),
            ),
            Effect.retry({ schedule: readinessPolicy }),
          );
        }),
    // firewall create (~10 min) + Lambda deploy.
    { timeout: 1_500_000 },
  );

  afterAll(
    gated || process.env.NO_DESTROY ? Effect.void : sharedStack.destroy(),
    // firewall delete waits for endpoint deprovisioning (~10 min).
    { timeout: 1_500_000 },
  );

  describe("binding registration", () => {
    test.provider.skipIf(gated)(
      "all 9 firewall-scoped capabilities initialize in the runtime",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/bindings")) as {
            bound: string[];
          };
          expect(response.bound).toHaveLength(9);
          expect(response.bound).toContain("describeFirewall");
          expect(response.bound).toContain("startFlowCapture");
          expect(response.bound).toContain("startAnalysisReport");
        }),
    );
  });

  describe("DescribeFirewall", () => {
    test.provider.skipIf(gated)(
      "reads the bound firewall's status (ARN injected)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/firewall")) as {
            status: string;
            endpointCount: number;
          };
          expect(response.status).toBe("READY");
          expect(response.endpointCount).toBeGreaterThanOrEqual(1);
        }),
    );
  });

  describe("StartFlowCapture / DescribeFlowOperation / ListFlowOperations / ListFlowOperationResults", () => {
    test.provider.skipIf(gated)(
      "runs a flow capture end-to-end on the bound firewall",
      (_stack) =>
        Effect.gen(function* () {
          type FlowResponse = {
            step: string;
            tag?: string;
            error?: string;
            flowOperationId?: string;
            status?: string;
            operations?: number;
            flows?: number;
          };
          // The role policy is attached moments before this test — IAM
          // propagation can lag, surfacing as AccessDeniedException from a
          // step. Retry (bounded) until the grant lands.
          const response = yield* getJson("/flow").pipe(
            Effect.map((r) => r as FlowResponse),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (r): boolean => r.tag !== "AccessDeniedException",
              times: 10,
            }),
          );
          yield* Effect.logInfo(`/flow response: ${JSON.stringify(response)}`);
          expect(response).toMatchObject({ step: "ok" });
          expect(response.flowOperationId).toBeTruthy();
          expect(["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED"]).toContain(
            response.status,
          );
          expect(response.operations).toBeGreaterThanOrEqual(1);
          expect(response.flows).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 180_000 },
    );
  });

  describe("StartFlowFlush", () => {
    test.provider.skipIf(gated)(
      "starts a flow flush (grant proven by success or typed rejection)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/flush")) as { tag: string };
          expect(response.tag).not.toBe("AccessDeniedException");
        }),
    );
  });

  describe("StartAnalysisReport / ListAnalysisReports / GetAnalysisReportResults", () => {
    test.provider.skipIf(gated)(
      "exercises the analysis-report interface (typed rejections prove grants)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/analysis")) as {
            step: string;
            startTag: string;
            reports: number;
            getTag: string;
          };
          expect(response.step).toBe("ok");
          // The fixture firewall has no analysis types enabled — any typed
          // tag except AccessDenied proves the grant round-tripped.
          expect(response.startTag).not.toBe("AccessDeniedException");
          expect(response.reports).toBeGreaterThanOrEqual(0);
          expect(response.getTag).not.toBe("AccessDeniedException");
        }),
    );
  });
});
