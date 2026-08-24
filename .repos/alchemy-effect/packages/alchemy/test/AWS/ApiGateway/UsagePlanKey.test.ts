import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "./Test.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { assertApiKeyDeleted, assertUsagePlanDeleted } from "./assertions.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(!!process.env.FAST)(
  "create and delete usage plan key association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

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
      yield* assertApiKeyDeleted(key.id);
      yield* assertUsagePlanDeleted(plan.id);
    }),
);

test.provider.skipIf(!!process.env.FAST)(
  "list enumerates the deployed usage plan key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { key, plan } = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* AWS.ApiGateway.ApiKey("AgUpkListKey", {
            generateDistinctId: true,
          });
          const plan = yield* AWS.ApiGateway.UsagePlan("AgUpkListPlan", {});
          yield* AWS.ApiGateway.UsagePlanKey("AgUpkListLink", {
            usagePlanId: plan.id,
            keyId: key.id,
          });
          return { key, plan };
        }),
      );

      const provider = yield* Provider.findProvider(
        AWS.ApiGateway.UsagePlanKey,
      );
      const all = yield* provider.list();

      expect(
        all.some((x) => x.usagePlanId === plan.id && x.keyId === key.id),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertApiKeyDeleted(key.id);
      yield* assertUsagePlanDeleted(plan.id);
    }),
);
