import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import LifecycleTestFunctionLive, {
  LifecycleTestFunction,
  lifecycleFleetAsgName,
  lifecycleHookName,
} from "./fixtures/lifecycle-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AutoScalingLifecycle");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

// Deploys a Lambda that (a) creates a LAUNCHING lifecycle hook + EventBridge
// subscription via `consumeLifecycleActions` and (b) binds
// `CompleteLifecycleAction`. The fleet is sized to zero so no EC2 instances
// launch — this verifies the DX wiring (hook creation + binding IAM) without a
// >90s instance-launch round-trip. The full "instance pauses → Lambda completes
// CONTINUE → InService" flow is left to a live run with a non-zero desired
// capacity.
describe("AutoScaling LifecycleHook event source + CompleteLifecycleAction", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      const { fn } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const fn = yield* LifecycleTestFunction;
          return { fn };
        }).pipe(Effect.provide(LifecycleTestFunctionLive)),
      );

      expect(fn.functionUrl).toBeTruthy();
      baseUrl = fn.functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Assert the fixture ASG is fully gone — the suite must leave nothing.
      // The hook context has no AWS providers of its own, so provide them
      // explicitly for the out-of-band distilled call.
      const remaining = yield* Core.withProviders(
        autoscaling
          .describeAutoScalingGroups({
            AutoScalingGroupNames: [lifecycleFleetAsgName],
          } as any)
          .pipe(
            Effect.map((r) => (r.AutoScalingGroups ?? []).length),
            Effect.repeat({
              until: (count) => count === 0,
              schedule: Schedule.spaced("3 seconds"),
              times: 10,
            }),
          ),
        testOptions,
        sharedStack.name,
      );
      expect(remaining).toBe(0);
    }),
    { timeout: 180_000 },
  );

  test.provider(
    "consumeLifecycleActions creates the launch lifecycle hook on the ASG",
    (_stack) =>
      Effect.gen(function* () {
        const hooks = yield* autoscaling.describeLifecycleHooks({
          AutoScalingGroupName: lifecycleFleetAsgName,
          LifecycleHookNames: [lifecycleHookName],
        } as any);
        const hook = hooks.LifecycleHooks?.[0];
        expect(hook?.LifecycleHookName).toEqual(lifecycleHookName);
        expect(hook?.LifecycleTransition).toEqual(
          "autoscaling:EC2_INSTANCE_LAUNCHING",
        );
        expect(hook?.HeartbeatTimeout).toEqual(300);
      }),
  );

  test.provider(
    "CompleteLifecycleAction binding is IAM-wired (no AccessDenied)",
    (_stack) =>
      Effect.gen(function* () {
        // A freshly attached IAM policy is eventually consistent — the first
        // invocations after deploy can still see AccessDenied. Poll (bounded)
        // until the call stops failing authorization, then assert.
        const body = yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/complete-bogus`),
        ).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(
                  new Error(`Function not ready: ${response.status}`),
                ),
          ),
          Effect.map((json) => json as { ok: boolean; tag: string }),
          Effect.repeat({
            until: (b) =>
              b.tag !== "AccessDenied" && b.tag !== "AccessDeniedException",
            schedule: Schedule.spaced("3 seconds"),
            times: 10,
          }),
        );
        // The SDK call reached AWS with valid credentials/policy: either it
        // succeeded, or it failed for a resource reason (no active lifecycle
        // action) — never an authorization failure.
        expect(["AccessDenied", "AccessDeniedException"]).not.toContain(
          body.tag,
        );
      }),
    { timeout: 60_000 },
  );
});
