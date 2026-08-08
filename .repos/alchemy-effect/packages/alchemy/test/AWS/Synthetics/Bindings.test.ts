import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SyntheticsBindingsFunctionLive, {
  SyntheticsBindingsFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SyntheticsBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

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

// The role policy granting synthetics:* is attached moments before the
// tests — IAM propagation can lag ~10-30s, surfacing as AccessDenied from a
// route. Retry (bounded) until the grant lands.
const getJsonUntilGranted = (path: string) =>
  getJson(path).pipe(
    Effect.map((r) => r as { tag: string }),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (r): boolean => r.tag !== "AccessDeniedException",
      times: 10,
    }),
  );

describe.sequential("Synthetics Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Synthetics test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Synthetics test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SyntheticsBindingsFunction;
        }).pipe(Effect.provide(SyntheticsBindingsFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Synthetics test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Synthetics test setup: fixture not ready yet (${String(error)})`,
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
        expect(response.bound).toContain("getCanary");
        expect(response.bound).toContain("getCanaryRuns");
        expect(response.bound).toContain("startCanary");
        expect(response.bound).toContain("stopCanary");
        expect(response.bound).toContain("describeCanariesLastRun");
      }),
    );
  });

  describe("GetCanary", () => {
    test.provider(
      "reads the bound canary's state (name injected)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJsonUntilGranted("/canary")) as {
            tag: string;
            state?: string;
          };
          expect(response.tag).toBe("ok");
          // Never started → READY (STOPPED once a run has completed).
          expect(["READY", "STOPPED", "RUNNING", "STARTING"]).toContain(
            response.state,
          );
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetCanaryRuns", () => {
    test.provider("lists runs on the bound canary", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJsonUntilGranted("/runs")) as {
          tag: string;
          count?: number;
        };
        expect(response.tag).toBe("ok");
        // A never-started canary has no runs; a zero count still proves the
        // grant + name injection round-tripped.
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("DescribeCanariesLastRun", () => {
    test.provider("reads last runs account-wide", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJsonUntilGranted("/last-run")) as {
          tag: string;
          count?: number;
        };
        expect(response.tag).toBe("ok");
        // Canaries that have never run report no last-run entry — a zero
        // count still proves synthetics:DescribeCanariesLastRun round-trips.
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("StopCanary", () => {
    test.provider(
      "typed rejection when the canary is not running (grant proven)",
      (_stack) =>
        Effect.gen(function* () {
          // The canary was deployed stopped (READY); stopping it is a
          // ConflictException — the typed tag proves synthetics:StopCanary
          // reached the API.
          const response = (yield* getJsonUntilGranted("/stop")) as {
            tag: string;
          };
          expect(["ok", "ConflictException"]).toContain(response.tag);
        }),
    );
  });

  describe("StartCanary", () => {
    test.provider(
      "starts the canary for its single scheduled run",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJsonUntilGranted("/start")) as {
            tag: string;
          };
          expect(response.tag).toBe("ok");
          // A one-shot canary can traverse READY -> RUNNING -> READY between
          // state polls. Prove the accepted start by observing its run record
          // instead of relying on a transient control-plane state.
          const started = yield* getJson("/runs").pipe(
            Effect.map((r) => r as { tag: string; count?: number }),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (r): boolean => r.tag === "ok" && (r.count ?? 0) > 0,
              times: 25,
            }),
          );
          expect(started.tag).toBe("ok");
          expect(started.count).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("consumeCanaryEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeCanaryEvents
          // must have materialized as a rule on the default bus with the
          // Lambda as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});
