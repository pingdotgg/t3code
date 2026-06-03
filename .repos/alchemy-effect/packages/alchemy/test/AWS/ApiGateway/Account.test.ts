import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_APIGATEWAY_TESTS === "true";

test.provider.skipIf(!runLive)("patch API Gateway account settings", (stack) =>
  Effect.gen(function* () {
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
);
