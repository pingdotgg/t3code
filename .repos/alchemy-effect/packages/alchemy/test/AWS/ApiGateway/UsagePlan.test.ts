import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "./Test.ts";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertUsagePlanDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(!!process.env.FAST)(
  "create and delete usage plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const plan = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.UsagePlan("AgUsagePlan", {
            description: "test plan",
          });
        }),
      );

      expect(plan.id).toBeDefined();

      yield* stack.destroy();
      yield* assertUsagePlanDeleted(plan.id);
    }),
);

test.provider.skipIf(!!process.env.FAST)(
  "usage plan throttle updates in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

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
      yield* assertUsagePlanDeleted(plan.id);
    }),
);

test.provider.skipIf(!!process.env.FAST)(
  "list enumerates the deployed usage plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const plan = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.UsagePlan("AgUsagePlanList", {
            description: "list test plan",
          });
        }),
      );

      const provider = yield* Provider.findProvider(AWS.ApiGateway.UsagePlan);
      const all = yield* provider.list();

      expect(all.some((p) => p.id === plan.id)).toBe(true);

      yield* stack.destroy();
      yield* assertUsagePlanDeleted(plan.id);
    }),
);
