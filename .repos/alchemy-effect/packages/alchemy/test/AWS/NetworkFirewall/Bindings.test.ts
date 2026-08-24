import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import NetworkFirewallBindingsFunctionLive, {
  NetworkFirewallBindingsFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "NetworkFirewallBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy). Retry only
// 5xx; a genuine 4xx/assertion failure surfaces immediately.
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

describe.sequential("NetworkFirewall Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "NetworkFirewall test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("NetworkFirewall test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* NetworkFirewallBindingsFunction;
        }).pipe(Effect.provide(NetworkFirewallBindingsFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `NetworkFirewall test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `NetworkFirewall test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(process.env.NO_DESTROY ? Effect.void : sharedStack.destroy(), {
    timeout: 300_000,
  });

  describe("binding registration", () => {
    test.provider("all 4 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(4);
        expect(response.bound).toContain("describeFirewallPolicy");
        expect(response.bound).toContain("describeRuleGroup");
        expect(response.bound).toContain("describeRuleGroupSummary");
        expect(response.bound).toContain("describeRuleGroupMetadata");
      }),
    );
  });

  describe("DescribeFirewallPolicy", () => {
    test.provider(
      "reads the bound policy's definition (ARN injected)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/policy")) as {
            status: string;
            statelessDefaultActions: string[];
          };
          expect(response.status).toBe("ACTIVE");
          expect(response.statelessDefaultActions).toEqual([
            "aws:forward_to_sfe",
          ]);
        }),
    );
  });

  describe("DescribeRuleGroup", () => {
    test.provider(
      "reads the bound rule group's rules (ARN injected)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/rule-group")) as {
            status: string;
            type: string;
            rulesString: string;
          };
          expect(response.status).toBe("ACTIVE");
          expect(response.type).toBe("STATEFUL");
          expect(response.rulesString).toContain("allow https");
        }),
    );
  });

  describe("DescribeRuleGroupSummary", () => {
    test.provider("summarizes the stateful rules", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/rule-group/summary")) as {
          ruleCount: number;
        };
        expect(response.ruleCount).toBe(1);
      }),
    );
  });

  describe("DescribeRuleGroupMetadata", () => {
    test.provider("reads capacity and type without the definition", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/rule-group/metadata")) as {
          capacity: number;
          type: string;
        };
        expect(response.capacity).toBe(10);
        expect(response.type).toBe("STATEFUL");
      }),
    );
  });
});
