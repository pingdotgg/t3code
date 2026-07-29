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
import ShieldTestFunctionLive, { ShieldTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ShieldBindings");

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

// The testing account is NOT (and must never be) subscribed to Shield
// Advanced. GetSubscriptionState and DescribeAttackStatistics succeed on any
// account; the subscription-gated operations answer with their typed
// entitlement/not-found tags — asserting the tag proves the binding + IAM
// grant end-to-end at near-zero cost.
describe.sequential("Shield Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Shield test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Shield test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ShieldTestFunction;
        }).pipe(Effect.provide(ShieldTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Shield test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Shield test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 6 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(6);
        expect(response.bound).toContain("getSubscriptionState");
        expect(response.bound).toContain("listAttacks");
      }),
    );
  });

  describe("GetSubscriptionState", () => {
    test.provider("answers on any account, subscribed or not", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/subscription-state")) as {
          state: string;
        };
        expect(["ACTIVE", "INACTIVE"]).toContain(response.state);
      }),
    );
  });

  describe("DescribeAttackStatistics", () => {
    test.provider(
      "returns the yearly attack statistics (available to Standard customers)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/attack-stats")) as {
            dataItems?: number;
            errorTag?: string;
          };
          expect(response.errorTag).toBeUndefined();
          expect(response.dataItems).toBeGreaterThanOrEqual(0);
        }),
    );
  });

  describe("ListAttacks", () => {
    test.provider(
      "answers with attacks or the typed subscription-gate tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/attacks")) as {
            count?: number;
            errorTag?: string;
          };
          if (response.errorTag) {
            expect([
              "InvalidOperationException",
              "SubscriptionNotFound",
            ]).toContain(response.errorTag);
          } else {
            expect(response.count).toBeGreaterThanOrEqual(0);
          }
        }),
    );
  });

  describe("DescribeAttack", () => {
    test.provider(
      "a nonexistent attack id answers with an empty document or the typed AccessDeniedException",
      (_stack) =>
        Effect.gen(function* () {
          // Observed live: Shield answers a nonexistent attack id with an
          // empty success (no Attack document); the documented alternative is
          // the typed AccessDeniedException. Either outcome proves the
          // binding + IAM grant end-to-end.
          const response = (yield* getJson("/attack-detail")) as {
            attackId?: string | null;
            errorTag?: string;
          };
          if (response.errorTag) {
            expect(response.errorTag).toBe("AccessDeniedException");
          } else {
            expect(response.attackId ?? null).toBeNull();
          }
        }),
    );
  });

  describe("DescribeDRTAccess", () => {
    test.provider(
      "a non-subscribed account answers with the typed ResourceNotFoundException",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/drt-access")) as {
            roleArn?: string | null;
            errorTag?: string;
          };
          if (response.errorTag) {
            expect(response.errorTag).toBe("ResourceNotFoundException");
          } else {
            // A subscribed account answers with the (possibly empty) grant.
            expect(response.roleArn !== undefined).toBe(true);
          }
        }),
    );
  });

  describe("ListResourcesInProtectionGroup", () => {
    test.provider(
      "a nonexistent group answers with the typed ResourceNotFoundException",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/group-members")) as {
            errorTag?: string;
          };
          expect(response.errorTag).toBe("ResourceNotFoundException");
        }),
    );
  });

  describe("consumeAttackEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeAttackEvents must
          // have materialized as a rule on the default bus with the Lambda as
          // target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});
