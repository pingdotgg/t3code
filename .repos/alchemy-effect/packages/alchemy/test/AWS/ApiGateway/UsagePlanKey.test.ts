import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_APIGATEWAY_TESTS === "true";

test.provider.skipIf(!runLive)(
  "create and delete usage plan key association",
  (stack) =>
    Effect.gen(function* () {
      const { key, plan } = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* AWS.ApiGateway.ApiKey("AgUpkKey", {
            generateDistinctId: true,
          });
          const plan = yield* AWS.ApiGateway.UsagePlan("AgUpkPlan", {});
          yield* AWS.ApiGateway.UsagePlanKey("AgUpkLink", {
            usagePlanId: plan.id,
            keyId: key.id,
          });
          return { key, plan };
        }),
      );

      expect(key.id).toBeDefined();
      expect(plan.id).toBeDefined();

      yield* stack.destroy();
    }),
);
