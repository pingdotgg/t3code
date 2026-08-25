import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Wafv2BindingsFunctionLive, { Wafv2BindingsFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "Wafv2Bindings");

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

const postJson = (path: string, body: object) =>
  send(
    HttpClientRequest.post(`${baseUrl}${path}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  ).pipe(Effect.flatMap((r) => r.json));

describe.sequential("WAFv2 Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("WAFv2 test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("WAFv2 test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* Wafv2BindingsFunction;
        }).pipe(Effect.provide(Wafv2BindingsFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `WAFv2 test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `WAFv2 test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 600_000 },
  );

  afterAll(process.env.NO_DESTROY ? Effect.void : sharedStack.destroy(), {
    timeout: 600_000,
  });

  describe("binding registration", () => {
    test.provider("all 20 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(20);
        expect(response.bound).toContain("getIPSet");
        expect(response.bound).toContain("updateIPSet");
        expect(response.bound).toContain("checkCapacity");
        expect(response.bound).toContain("getWebACLForResource");
      }),
    );
  });

  describe("GetIPSet / UpdateIPSet", () => {
    test.provider(
      "reads and replaces the dynamic block list (LockToken handled)",
      (_stack) =>
        Effect.gen(function* () {
          const initial = (yield* getJson("/ip-set")) as {
            addresses: string[];
            description: string;
          };
          expect(initial.addresses).toEqual(["192.0.2.44/32"]);
          expect(initial.description).toBe("bindings fixture");

          const updated = (yield* postJson("/ip-set", {
            addresses: ["192.0.2.44/32", "198.51.100.7/32"],
          })) as { addresses: string[] };
          expect(updated.addresses).toEqual([
            "192.0.2.44/32",
            "198.51.100.7/32",
          ]);

          // restore for idempotent re-runs
          const restored = (yield* postJson("/ip-set", {
            addresses: ["192.0.2.44/32"],
          })) as { addresses: string[] };
          expect(restored.addresses).toEqual(["192.0.2.44/32"]);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetSampledRequests", () => {
    test.provider("reads the (empty) sample for the rate rule", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/sampled")) as {
          sampled: number;
          populationSize: number;
        };
        expect(response.sampled).toBe(0);
      }),
    );
  });

  describe("GetRateBasedStatementManagedKeys", () => {
    test.provider("reads the currently rate-limited addresses", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/rate-keys")) as {
          v4: number;
          v4Version: string | null;
        };
        expect(response.v4).toBe(0);
        expect(response.v4Version).toBe("IPV4");
      }),
    );
  });

  describe("ListResourcesForWebACL", () => {
    test.provider("lists no associated resources", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/resources")) as {
          resources: string[];
        };
        expect(response.resources).toEqual([]);
      }),
    );
  });

  describe("GetTopPathStatisticsByTraffic", () => {
    test.provider("returns data or the typed pricing-plan gate", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/top-paths")) as {
          ok: boolean;
          tag: string | null;
        };
        if (!response.ok) {
          // account without the bot-statistics pricing plan — the typed
          // tag proves the grant + wiring reached WAF
          expect([
            "WAFFeatureNotIncludedInPricingPlanException",
            "WAFInvalidOperationException",
            "WAFNonexistentItemException",
          ]).toContain(response.tag);
        }
      }),
    );
  });

  describe("PutPermissionPolicy / GetPermissionPolicy / DeletePermissionPolicy", () => {
    test.provider("shares and unshares the rule group", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/permission-policy")) as {
          beforePolicy: string | null;
          hasPolicy: boolean;
          deleted: boolean;
        };
        expect(response.beforePolicy).toBeNull();
        expect(response.hasPolicy).toBe(true);
        expect(response.deleted).toBe(true);
      }),
    );
  });

  describe("CheckCapacity", () => {
    test.provider("computes the WCU cost of a geo-match rule", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/capacity")) as {
          capacity: number;
        };
        expect(response.capacity).toBeGreaterThan(0);
      }),
    );
  });

  describe("CAPTCHA API keys", () => {
    test.provider("mints, lists, decrypts, and deletes an API key", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/api-keys")) as {
          created: boolean;
          listed: number;
          domains: string[];
          deleted: boolean;
        };
        expect(response.created).toBe(true);
        expect(response.listed).toBeGreaterThan(0);
        expect(response.domains).toContain("example.com");
        expect(response.deleted).toBe(true);
      }),
    );
  });

  describe("managed rule group catalog", () => {
    test.provider("lists groups and describes the common rule set", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/managed")) as {
          groups: number;
          capacity: number;
          currentDefaultVersion: string | null;
        };
        expect(response.groups).toBeGreaterThan(0);
        expect(response.capacity).toBeGreaterThan(0);
        expect(response.currentDefaultVersion).toBeTruthy();
      }),
    );

    test.provider("reads the managed products catalog", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/products")) as {
          all: number;
          aws: number;
        };
        expect(response.all).toBeGreaterThan(0);
        expect(response.aws).toBeGreaterThan(0);
      }),
    );
  });

  describe("GetWebACLForResource", () => {
    test.provider(
      "returns not-found for an unassociated resource (typed)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/waf-for-resource")) as {
            found: boolean;
          };
          expect(response.found).toBe(false);
        }),
    );
  });
});
