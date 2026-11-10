import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Test from "./Test.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(!!process.env.FAST)(
  "patch API Gateway account settings",
  (stack) =>
    Effect.gen(function* () {
      // Account settings are a singleton patch resource — the leading destroy
      // clears any prior partial deployment before capturing the baseline.
      yield* stack.destroy();

      const before = yield* ag.getAccount({});

      yield* stack.deploy(
        Effect.gen(function* () {
          yield* AWS.ApiGateway.Account("AgAccount", {});
          return undefined;
        }),
      );

      const account = yield* ag.getAccount({});
      expect(account).toBeDefined();

      yield* stack.destroy();

      const after = yield* ag.getAccount({});
      expect(after.cloudwatchRoleArn).toEqual(before.cloudwatchRoleArn);
    }),
  { tags: ["provider:aws", "provider:aws:apigateway", "live"] },
);

test.provider.skipIf(!!process.env.FAST)(
  "list returns the account settings singleton",
  (stack) =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(AWS.ApiGateway.Account);
      const all = yield* provider.list();

      // Account settings are an account/region singleton — always exactly one.
      expect(all.length).toBe(1);
      expect(all[0]).toHaveProperty("managesCloudwatchRoleArn");

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:apigateway", "live"] },
);
