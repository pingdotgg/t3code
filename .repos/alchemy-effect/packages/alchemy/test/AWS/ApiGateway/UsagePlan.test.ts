import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_APIGATEWAY_TESTS === "true";

test.provider.skipIf(!runLive)("create and delete usage plan", (stack) =>
  Effect.gen(function* () {
    const plan = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* AWS.ApiGateway.UsagePlan("AgUsagePlan", {
          description: "test plan",
        });
      }),
    );

    expect(plan.id).toBeDefined();

    yield* stack.destroy();
  }),
);

test.provider.skipIf(!runLive)(
  "usage plan throttle updates in place",
  (stack) =>
    Effect.gen(function* () {
      const plan = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.UsagePlan("AgUsagePlanThrottle", {
            throttle: { burstLimit: 10, rateLimit: 100 },
          });
        }),
      );

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.UsagePlan("AgUsagePlanThrottle", {
            throttle: { burstLimit: 20, rateLimit: 200 },
          });
        }),
      );

      const remote = yield* ag.getUsagePlan({ usagePlanId: plan.id });
      expect(remote.throttle?.burstLimit).toEqual(20);
      expect(remote.throttle?.rateLimit).toEqual(200);

      yield* stack.destroy();
    }),
);
