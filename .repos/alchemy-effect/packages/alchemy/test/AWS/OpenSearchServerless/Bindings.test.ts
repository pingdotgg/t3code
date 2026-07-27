import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AossBindingsFunctionLive, {
  AossBindingsFunction,
} from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AossBindings");

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
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

describe.sequential("OpenSearchServerless Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("AOSS test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("AOSS test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AossBindingsFunction;
        }).pipe(Effect.provide(AossBindingsFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `AOSS test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `AOSS test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  describe("binding registration", () => {
    test.provider("all 4 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(4);
      }),
    );
  });

  describe("GetAccountSettings", () => {
    test.provider("reads the account's capacity limits", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/account-settings`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        // Limits may be unset on a fresh account — the call round-tripping
        // proves the grant.
        expect(response).toHaveProperty("capacityLimits");
      }),
    );
  });

  describe("UpdateAccountSettings", () => {
    test.provider("writes back the observed capacity limits", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.post(`${baseUrl}/account-settings/noop`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(
          response.capacityLimits?.maxIndexingCapacityInOCU,
        ).toBeGreaterThan(0);
      }),
    );
  });

  describe("GetPoliciesStats", () => {
    test.provider("counts the account's aoss policies", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/policies-stats`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;
        expect(typeof response.total).toBe("number");
      }),
    );
  });

  describe("BatchGetEffectiveLifecyclePolicy", () => {
    test.provider(
      "resolves a nonexistent index through the error-detail channel",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/effective-lifecycle`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;
          expect(response.details + response.errors).toBeGreaterThan(0);
        }),
    );
  });
});
