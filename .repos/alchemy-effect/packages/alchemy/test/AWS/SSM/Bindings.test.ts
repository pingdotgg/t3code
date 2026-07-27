import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as ssm from "@distilled.cloud/aws/ssm";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SSMTestFunctionLive, { SSMTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SSMBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load. Budget ~150s of
// readiness polling.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

class ParameterStillExists extends Data.TaggedError("ParameterStillExists")<{
  readonly name: string;
}> {}

const assertParameterDeleted = (name: string) =>
  ssm.getParameter({ Name: name }).pipe(
    Effect.flatMap(() => Effect.fail(new ParameterStillExists({ name }))),
    Effect.catchTag("ParameterNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ParameterStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// parallel load (cold re-init, IAM propagation). Retry 5xx only; a genuine
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

describe.sequential("SSM Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("SSM test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SSM test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SSMTestFunction;
        }).pipe(Effect.provide(SSMTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;
      const readinessUrl = `${baseUrl}/get-string`;

      yield* Effect.logInfo(
        `SSM test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SSM test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  // Idempotent backstop — the "destroy leaves nothing behind" test below is
  // the primary teardown; this reclaims resources if that test never ran.
  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("GetParameter", () => {
    test.provider("reads a String parameter through the binding", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/get-string");

        expect((response as any).type).toBe("String");
        expect((response as any).value).toBe("plain-config-value");
      }),
    );

    test.provider(
      "decrypts a SecureString parameter through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/get-secure");

          expect((response as any).type).toBe("SecureString");
          expect((response as any).value).toBe("bound-secret-value");
        }),
    );
  });

  describe("GetParameters", () => {
    test.provider(
      "reads String and SecureString parameters in one call",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* getJson("/get-many");

          const parameters = (response as any).parameters as Array<{
            name: string;
            type: string;
            value: string;
          }>;
          expect((response as any).invalidParameters).toEqual([]);
          expect(parameters).toHaveLength(2);
          const values = parameters.map((p) => p.value).sort();
          expect(values).toEqual(
            ["bound-secret-value", "plain-config-value"].sort(),
          );
        }),
    );
  });

  describe("GetParameterHistory", () => {
    test.provider(
      "reads the deployed version from the parameter's history",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/history")) as {
            count: number;
            values: string[];
          };
          expect(response.count).toBeGreaterThanOrEqual(1);
          expect(response.values).toContain("v1");
        }),
    );
  });

  describe("PutParameter", () => {
    test.provider(
      "writes a new version of the bound parameter at runtime",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/put")) as {
            version: number;
            latest: string;
          };
          expect(response.version).toBeGreaterThanOrEqual(2);
          expect(response.latest).toBe("v2-runtime");
        }),
    );
  });

  describe("Label/UnlabelParameterVersion", () => {
    test.provider(
      "labels the latest version and removes the label again",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/label-cycle")) as {
            labeledVersion: number;
            invalidLabels: string[];
            removedLabels: string[];
          };
          expect(response.labeledVersion).toBeGreaterThanOrEqual(1);
          expect(response.invalidLabels).toEqual([]);
          expect(response.removedLabels).toContain("current");
        }),
    );
  });

  describe("GetParametersByPath", () => {
    test.provider(
      "reads the subtree under the bound path-root parameter",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/by-path")) as {
            parameters: Array<{ name: string; value: string }>;
          };
          const child = response.parameters.find(
            (parameter) =>
              parameter.name === "/alchemy-test/ssm-bindings/root/child",
          );
          expect(child?.value).toBe("child-value");
        }),
    );
  });

  describe("consumeParameterEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeParameterEvents
          // must have materialized as a rule on the default bus with the
          // Lambda as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });

  // Runs last (describe.sequential): tear the shared stack down and prove
  // out-of-band that the destroy left nothing behind. The afterAll destroy
  // stays registered as an idempotent backstop for crashes before this test.
  describe("teardown", () => {
    test.provider(
      "destroy leaves no parameters behind",
      (_stack) =>
        Effect.gen(function* () {
          yield* sharedStack.destroy();
          yield* assertParameterDeleted("/alchemy-test/ssm-bindings/root");
          yield* assertParameterDeleted(
            "/alchemy-test/ssm-bindings/root/child",
          );
        }),
      { timeout: 120_000 },
    );
  });
});
