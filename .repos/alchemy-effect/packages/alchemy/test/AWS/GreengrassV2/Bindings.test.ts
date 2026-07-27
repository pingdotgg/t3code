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
import GreengrassTestFunctionLive, {
  COMPONENT_NAME,
  COMPONENT_VERSION,
  GreengrassTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "GreengrassV2Bindings");

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

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

// A type alias (not an interface) so it keeps the implicit index signature —
// interfaces are not comparable to the JSON `JsonObject` type that
// `response.json` returns, which breaks the `as Probe` casts below.
type Probe = {
  ok: boolean;
  tag?: string;
};

describe.sequential("GreengrassV2 Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "GreengrassV2 test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("GreengrassV2 test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* GreengrassTestFunction;
        }).pipe(Effect.provide(GreengrassTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `GreengrassV2 test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `GreengrassV2 test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 180_000 });

  describe("binding registration", () => {
    test.provider("all 19 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(19);
      }),
    );
  });

  describe("DescribeComponent", () => {
    test.provider(
      "reads the bound component version's metadata (injected arn)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/component")) as {
            arn: string;
            componentName: string;
            componentVersion: string;
            state: string;
          };
          expect(response.componentName).toBe(COMPONENT_NAME);
          expect(response.componentVersion).toBe(COMPONENT_VERSION);
          expect(response.arn).toContain(
            `:components:${COMPONENT_NAME}:versions:${COMPONENT_VERSION}`,
          );
          expect(response.state).toBe("DEPLOYABLE");
        }),
    );
  });

  describe("GetComponent", () => {
    test.provider("fetches the recipe (round-trips the name)", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/recipe")) as {
          recipeOutputFormat: string;
          hasName: boolean;
        };
        expect(response.recipeOutputFormat).toBe("JSON");
        expect(response.hasName).toBe(true);
      }),
    );
  });

  describe("GetComponentVersionArtifact", () => {
    test.provider(
      "a missing artifact surfaces a typed error (never AccessDenied)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/artifact")) as Probe;
          expect(response.ok).toBe(false);
          expect(response.tag).not.toBe("AccessDeniedException");
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(response.tag);
        }),
    );
  });

  describe("GetDeployment", () => {
    test.provider(
      "reads the bound deployment's detail (injected deployment id)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/deployment")) as {
            deploymentId: string;
            deploymentStatus: string;
            targetArn: string;
            isLatestForTarget: boolean;
          };
          expect(response.deploymentId).toBeTruthy();
          expect(response.targetArn).toContain(":thing/");
          expect(response.isLatestForTarget).toBe(true);
        }),
    );
  });

  describe("ListDeployments", () => {
    test.provider("enumerates the account's latest deployments", (_stack) =>
      Effect.gen(function* () {
        const deployment = (yield* getJson("/deployment")) as {
          deploymentId: string;
        };
        const response = (yield* getJson("/deployments")) as { ids: string[] };
        expect(response.ids).toContain(deployment.deploymentId);
      }),
    );
  });

  describe("ListComponents", () => {
    test.provider(
      "enumerates private components incl. the fixture's",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/components")) as {
            names: string[];
          };
          expect(response.names).toContain(COMPONENT_NAME);
        }),
    );
  });

  describe("ListComponentVersions", () => {
    test.provider("lists the fixture component's versions", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/component-versions")) as {
          versions: string[];
        };
        expect(response.versions).toContain(COMPONENT_VERSION);
      }),
    );
  });

  describe("ListCoreDevices", () => {
    test.provider("enumerates core devices (count is a number)", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/core-devices")) as { count: number };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("core device bindings", () => {
    test.provider(
      "probes against a missing core device return typed errors (never AccessDenied)",
      (_stack) =>
        Effect.gen(function* () {
          // Freshly attached IAM policy statements are eventually consistent —
          // poll (bounded) until the grants have propagated before asserting
          // the steady-state invariant below.
          const response = (yield* getJson("/core-device-probes").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r): boolean =>
                Object.values(r as Record<string, Probe>).every(
                  (probe) => probe.tag !== "AccessDeniedException",
                ),
              times: 20,
            }),
          )) as Record<string, Probe>;
          // Point reads/writes on a missing core device are typed not-found.
          expect(response.getCoreDevice!.tag).toBe("ResourceNotFoundException");
          expect(response.deleteCoreDevice!.tag).toBe(
            "ResourceNotFoundException",
          );
          // Every probe proves IAM: none may be AccessDenied.
          for (const probe of Object.values(response)) {
            expect(probe.tag).not.toBe("AccessDeniedException");
          }
        }),
      { timeout: 240_000 },
    );
  });

  describe("connectivity info", () => {
    test.provider(
      "UpdateConnectivityInfo + GetConnectivityInfo round-trip on the fixture thing",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/connectivity")) as {
            hostAddresses: string[];
          };
          expect(response.hostAddresses).toContain("127.0.0.1");
        }),
      { timeout: 120_000 },
    );
  });

  describe("ResolveComponentCandidates", () => {
    // Per the AWS API reference, ResolveComponentCandidates must be called
    // through the Greengrass data plane endpoint with an AWS IoT device
    // certificate; IAM-signed calls are rejected with AccessDeniedException
    // even with greengrass:ResolveComponentCandidates granted. This ungated
    // probe proves the binding's request plumbing end-to-end: the call
    // reaches the service and surfaces the documented typed rejection.
    test.provider(
      "IAM-signed resolve surfaces the documented typed rejection",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/resolve")) as {
            ok: boolean;
            names: string[];
            tag?: string;
          };
          expect(response.ok).toBe(false);
          expect(response.tag).toBe("AccessDeniedException");
        }),
    );
  });

  describe("consumeGreengrassEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeGreengrassEvents
          // must have materialized as a rule on the default bus with the
          // Lambda as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });

  describe("CancelDeployment", () => {
    // Runs last: cancels the fixture rollout (the deployment stays ACTIVE
    // until canceled because no live core device ever picks it up).
    test.provider(
      "cancels the bound deployment",
      (_stack) =>
        Effect.gen(function* () {
          // The cancel path exercises freshly attached iot:CancelJob/UpdateJob
          // grants — retry the attempt while IAM propagation still rejects it.
          // A prior (retried) attempt may already have canceled the rollout,
          // so the deployment status below is the authoritative assertion.
          const response = (yield* postJson("/cancel-deployment").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r): boolean =>
                (r as Probe).tag !== "AccessDeniedException",
              times: 20,
            }),
          )) as Probe;
          expect(response.tag).not.toBe("AccessDeniedException");
          const detail = (yield* getJson("/deployment").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (d): boolean =>
                (d as { deploymentStatus: string }).deploymentStatus ===
                "CANCELED",
              times: 10,
            }),
          )) as { deploymentStatus: string };
          expect(detail.deploymentStatus).toBe("CANCELED");
        }),
      { timeout: 150_000 },
    );
  });
});
