import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Route53ResolverBindingsFunctionLive, {
  Route53ResolverBindingsFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "Route53ResolverBindings");

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

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("Route53Resolver Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Route53Resolver test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Route53Resolver test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* Route53ResolverBindingsFunction;
        }).pipe(Effect.provide(Route53ResolverBindingsFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Route53Resolver test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Route53Resolver test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 420_000 },
  );

  afterAll(process.env.NO_DESTROY ? Effect.void : sharedStack.destroy(), {
    timeout: 420_000,
  });

  describe("binding registration", () => {
    test.provider("all 5 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(5);
        expect(response.bound).toContain("getResolverEndpoint");
        expect(response.bound).toContain("listResolverEndpointIpAddresses");
        expect(response.bound).toContain("getResolverRule");
        expect(response.bound).toContain("updateResolverRule");
        expect(response.bound).toContain("listResolverRuleAssociations");
      }),
    );
  });

  describe("GetResolverEndpoint", () => {
    test.provider(
      "reads the bound endpoint's live state (ID injected)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/endpoint")) as {
            status: string;
            direction: string;
            ipAddressCount: number;
          };
          expect(response.direction).toBe("OUTBOUND");
          expect(response.status).toBe("OPERATIONAL");
          expect(response.ipAddressCount).toBe(2);
        }),
    );
  });

  describe("ListResolverEndpointIpAddresses", () => {
    test.provider("discovers the endpoint's attached IPs", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/endpoint/ips")) as {
          ips: { ip: string; status: string }[];
        };
        expect(response.ips).toHaveLength(2);
        for (const entry of response.ips) {
          expect(entry.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
          expect(entry.status).toBe("ATTACHED");
        }
      }),
    );
  });

  describe("GetResolverRule", () => {
    test.provider("reads the bound rule's targets (ID injected)", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/rule")) as {
          domainName: string;
          ruleType: string;
          targetIps: string[];
        };
        expect(response.domainName.replace(/\.$/, "")).toBe(
          "bindings.alchemy-r53r-test.internal",
        );
        expect(response.ruleType).toBe("FORWARD");
        expect(response.targetIps).toEqual(["10.100.0.10"]);
      }),
    );
  });

  describe("UpdateResolverRule", () => {
    test.provider(
      "fails the rule over to a new target IP at runtime",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/rule/target?ip=10.100.0.11")) as {
            status: string;
            targetIps: string[];
          };
          expect(response.targetIps).toEqual(["10.100.0.11"]);

          // The update settles asynchronously — poll the rule-scoped read
          // (bounded) until the new target is observed.
          const updated = yield* getJson("/rule").pipe(
            Effect.map((r) => r as { targetIps: string[] }),
            Effect.repeat({
              schedule: Schedule.fixed("3 seconds"),
              until: (r): boolean => r.targetIps.includes("10.100.0.11"),
              times: 10,
            }),
          );
          expect(updated.targetIps).toEqual(["10.100.0.11"]);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListResolverRuleAssociations", () => {
    test.provider(
      "lists the bound rule's VPC associations (filter injected)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/rule/associations")) as {
            count: number;
          };
          // The fixture never associates the rule with a VPC — an empty,
          // successfully-authorized listing proves the wiring and the
          // rule-scoped IAM grant.
          expect(response.count).toBe(0);
        }),
    );
  });
});
