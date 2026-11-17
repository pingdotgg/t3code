import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { assertApiKeyDeleted } from "./assertions.ts";
import * as Test from "./Test.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider.skipIf(!!process.env.FAST)(
  "create and delete API key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

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
      yield* assertApiKeyDeleted(key.id);
    }),
  { tags: ["provider:aws", "provider:aws:apigateway", "live"] },
);

test.provider.skipIf(!!process.env.FAST)(
  "custom API key value is not returned in outputs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const key = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.ApiKey("AgApiKeySecret", {
            value: Redacted.make("alchemy-test-secret-value-abc123"),
          });
        }),
      );

      expect(key.id).toBeDefined();
      expect(Object.keys(key as Record<string, unknown>)).not.toContain("value");

      yield* stack.destroy();
      yield* assertApiKeyDeleted(key.id);
    }),
  { tags: ["provider:aws", "provider:aws:apigateway", "live"] },
);

test.provider.skipIf(!!process.env.FAST)(
  "list enumerates the deployed API key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const key = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.ApiGateway.ApiKey("AgApiKeyList", {
            generateDistinctId: true,
            enabled: true,
          });
        }),
      );

      const provider = yield* Provider.findProvider(AWS.ApiGateway.ApiKey);
      const all = yield* provider.list();

      expect(all.some((k) => k.id === key.id)).toBe(true);

      yield* stack.destroy();
      yield* assertApiKeyDeleted(key.id);
    }),
  { tags: ["provider:aws", "provider:aws:apigateway", "live"] },
);
