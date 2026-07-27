import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Route53BindingsFunctionLive, {
  Route53BindingsFunction,
} from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "Route53Bindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
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
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
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
      schedule: Schedule.max([Schedule.fixed("4 seconds"), Schedule.recurs(9)]),
    }),
  );

describe.sequential("Route53 Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Route53 test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Route53 test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* Route53BindingsFunction;
        }).pipe(Effect.provide(Route53BindingsFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Probe /zone (not /bindings): it exercises the route53:GetHostedZone
      // grant, so the readiness loop also absorbs IAM propagation on the
      // freshly attached policy — otherwise the first real test can hit a
      // 500 (AccessDenied via orDie) before the policy is live.
      const readinessUrl = `${baseUrl}/zone`;
      yield* Effect.logInfo(
        `Route53 test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Route53 test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  describe("binding registration", () => {
    test.provider("all 10 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(10);
      }),
    );
  });

  describe("GetHostedZone", () => {
    test.provider("reads the bound zone's delegation set", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/zone`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.name).toBe("alchemy-route53-bindings.alchemy.");
        // Public zones get exactly 4 authoritative name servers.
        expect(response.nameServerCount).toBe(4);
      }),
    );
  });

  describe("ListHostedZones", () => {
    test.provider("lists the account's zones including ours", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/zones`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.count).toBeGreaterThanOrEqual(1);
        expect(response.found).toBe(true);
      }),
    );
  });

  describe("ListHostedZonesByName", () => {
    test.provider("finds the fixture zone by DNS name", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/zones/by-name`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.firstName).toBe("alchemy-route53-bindings.alchemy.");
      }),
    );
  });

  describe("ListHostedZonesByVPC", () => {
    test.provider(
      "round-trips the VPC ownership rejection for a foreign VPC id",
      (_stack) =>
        Effect.gen(function* () {
          // Route 53 rejects VPC ids the account doesn't own with the typed
          // AccessDeniedException ("not owned by you") — reaching that
          // ownership check proves the grant + query encoding end-to-end.
          // notOwned=false would mean a genuine IAM denial: fail loudly.
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/zones/by-vpc`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(response.count).toBe(0);
          if (response.rejected && !response.notOwned) {
            // Include the upstream rejection detail in the failure output.
            expect.fail(
              `unexpected rejection (genuine IAM denial?): ${response.detail}`,
            );
          }
        }),
    );
  });

  describe("TestDNSAnswer", () => {
    test.provider("answers the zone apex NS query", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/dns-test`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.responseCode).toBe("NOERROR");
        expect(response.recordCount).toBe(4);
      }),
    );
  });

  describe("ChangeResourceRecordSets + GetChange + ListResourceRecordSets", () => {
    test.provider(
      "upserts a TXT record, waits INSYNC, lists it, deletes it",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/record/roundtrip`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(response.changeStatus).toBe("INSYNC");
          expect(response.found).toBe(true);
          expect(response.deleted).toBe(true);
        }),
      { timeout: 150_000 },
    );
  });

  describe("GetHealthCheckStatus", () => {
    test.provider("reads checker observations for the bound check", (_stack) =>
      Effect.gen(function* () {
        // A freshly created check may not have observations yet — the call
        // round-tripping (HealthCheckId injection + check-scoped IAM) is the
        // assertion.
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/health/status`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.observations).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("GetHealthCheckLastFailureReason", () => {
    test.provider("reads last failure reasons for the bound check", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/health/failure-reason`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(response.observations).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});
