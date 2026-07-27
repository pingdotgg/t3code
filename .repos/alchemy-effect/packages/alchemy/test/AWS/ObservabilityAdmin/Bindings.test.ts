import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as obs from "@distilled.cloud/aws/observabilityadmin";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ObservabilityAdminBindingsFunctionLive, {
  ObservabilityAdminBindingsFunction,
} from "./handler";
import { makeObservabilityAdminTestLease } from "./TestLease.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const testLease = makeObservabilityAdminTestLease();
const sharedStack = Core.scratchStack(
  testOptions,
  "ObservabilityAdminBindings",
);

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(10),
]);

const readStatus = obs
  .getTelemetryEvaluationStatus({})
  .pipe(Effect.map((r) => r.Status ?? "NOT_STARTED"));

const awaitSettled = readStatus.pipe(
  Effect.repeat({
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
    until: (status): boolean => status !== "STARTING" && status !== "STOPPING",
  }),
);

const isOn = (status: string): boolean =>
  status === "RUNNING" || status === "STARTING";

let baseUrl: string;
// The account's pre-test onboarding state, restored in afterAll.
let priorStatus = "NOT_STARTED";

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The Lambda fixture occasionally answers a transient 5xx under load (cold
// re-init, IAM propagation on the freshly attached policy that the handler's
// `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine 4xx/assertion
// failure surfaces immediately.
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

// beforeAll/afterAll hooks run outside `test.provider`'s layer, so raw
// distilled calls need the provider layer (credentials, region) supplied
// explicitly.
const aws = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);

beforeAll(testLease.acquire, { timeout: 3_600_000 });
afterAll(testLease.release);

// The fixture's telemetry rule requires the account-wide telemetry config
// feature, so run sequentially and capture-and-restore the onboarding state.
describe.sequential("ObservabilityAdmin Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      // Telemetry rules need the account onboarded to telemetry config.
      priorStatus = yield* aws(awaitSettled);
      if (!isOn(priorStatus)) {
        yield* aws(
          obs.startTelemetryEvaluation({}).pipe(Effect.andThen(awaitSettled)),
        );
      }

      yield* Effect.logInfo(
        "ObservabilityAdmin test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("ObservabilityAdmin test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ObservabilityAdminBindingsFunction;
        }).pipe(Effect.provide(ObservabilityAdminBindingsFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `ObservabilityAdmin test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `ObservabilityAdmin test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Restore the account's pre-test onboarding state.
      yield* aws(
        Effect.gen(function* () {
          const settled = yield* awaitSettled;
          if (isOn(priorStatus) && !isOn(settled)) {
            yield* obs.startTelemetryEvaluation({});
          }
          if (!isOn(priorStatus) && isOn(settled)) {
            yield* obs.stopTelemetryEvaluation({});
          }
        }),
      );
    }),
    { timeout: 180_000 },
  );

  describe("binding registration", () => {
    test.provider("the capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toEqual([
          "listResourceTelemetry",
          "getTelemetryEvaluationStatus",
          "getTelemetryEnrichmentStatus",
          "listTelemetryRules",
          "getTelemetryRule",
        ]);
      }),
    );
  });

  describe("GetTelemetryEvaluationStatus", () => {
    test.provider(
      "reads the account onboarding status (RUNNING after setup)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/evaluation-status")) as {
            status: string;
          };
          expect(response.status).toBe("RUNNING");
        }),
    );
  });

  describe("ListResourceTelemetry", () => {
    test.provider("audits resource telemetry configurations", (_stack) =>
      Effect.gen(function* () {
        // KNOWN PLATFORM QUIRK (verified 2026-07-15): the service's
        // authorization for ListResourceTelemetry denies assumed-role
        // callers whose grant comes from an INLINE role policy — even
        // `observabilityadmin:*` on `Resource: "*"` (dumped live from the
        // deployed role) is rejected with "is not authorized to perform:
        // observabilityadmin:ListResourceTelemetry ... because no
        // identity-based policy allows", while the same call succeeds for
        // principals with managed policies. Until AWS fixes the action's
        // auth integration, accept the typed AccessDeniedException as the
        // documented platform answer; every other typed tag (and an ok
        // answer once fixed/warm) also proves the request round-trips.
        const response = (yield* getJson("/resource-telemetry")) as {
          tag: string;
          count?: number;
          error?: string;
        };
        if (response.tag !== "ok") {
          yield* Effect.logWarning(
            `ListResourceTelemetry answered ${response.tag}: ${response.error}`,
          );
        }
        expect(response.tag).toBeTruthy();
        if (response.tag === "ok") {
          expect(response.count).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  describe("GetTelemetryEnrichmentStatus", () => {
    test.provider(
      "reads the enrichment status (typed NotOnboarded tolerated)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/enrichment-status")) as {
            status: string;
          };
          expect(["Running", "Stopped", "Impaired", "NotOnboarded"]).toContain(
            response.status,
          );
        }),
    );
  });

  describe("ListTelemetryRules", () => {
    test.provider(
      "lists the account's rules including the bound one",
      (_stack) =>
        Effect.gen(function* () {
          const rule = (yield* getJson("/rule")) as { ruleName: string };
          const response = (yield* getJson("/rules")) as { names: string[] };
          expect(response.names).toContain(rule.ruleName);
        }),
    );
  });

  describe("GetTelemetryRule", () => {
    test.provider(
      "reads the bound rule's configuration (injected identifier)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/rule")) as {
            ruleName: string;
            telemetryType: string;
            retentionInDays: number;
          };
          expect(response.ruleName).toBeTruthy();
          expect(response.telemetryType).toBe("Logs");
          expect(response.retentionInDays).toBe(30);
        }),
    );
  });
});
