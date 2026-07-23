import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_APIGATEWAY_TESTS === "true";

test.provider.skipIf(!runLive)("create and delete API key", (stack) =>
  Effect.gen(function* () {
    const key = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* AWS.ApiGateway.ApiKey("AgApiKey", {
          generateDistinctId: true,
          enabled: true,
        });
      }),
    );

    expect(key.id).toBeDefined();

    yield* stack.destroy();
  }),
);

test.provider.skipIf(!runLive)(
  "custom API key value is not returned in outputs",
  (stack) =>
    Effect.gen(function* () {
      const key = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.ApiKey("AgApiKeySecret", {
            value: Redacted.make("alchemy-test-secret-value-abc123"),
          });
        }),
      );

      expect(key.id).toBeDefined();
      expect(Object.keys(key as Record<string, unknown>)).not.toContain(
        "value",
      );

      yield* stack.destroy();
    }),
);
