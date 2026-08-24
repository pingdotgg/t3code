import * as AWS from "@/AWS";
import { Function } from "@/AWS/CloudFront";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create and delete a CloudFront Function with key value store associations",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* AWS.CloudFront.KeyValueStore("RequestStore", {
            comment: "request metadata",
          });
          const fn = yield* AWS.CloudFront.Function("RequestFn", {
            comment: "request handler",
            keyValueStoreArns: [store.keyValueStoreArn],
            code: `async function handler(event) {
  return event.request;
}`,
          });
          return { store, fn };
        }),
      );

      const current = yield* cloudfront.describeFunction({
        Name: deployed.fn.functionName,
        Stage: "LIVE",
      });
      expect(current.FunctionSummary?.Name).toEqual(deployed.fn.functionName);
      expect(
        current.FunctionSummary?.FunctionConfig.KeyValueStoreAssociations
          ?.Items?.[0]?.KeyValueStoreARN,
      ).toEqual(deployed.store.keyValueStoreArn);

      yield* stack.destroy();
      yield* assertFunctionDeleted(deployed.fn.functionName);
    }),
  { timeout: 300_000 },
);

// `FunctionConfig.Comment` is patched optional in
// distilled/packages/aws/patches/cloudfront.json — CloudFront omits `Comment`
// in `listFunctions` responses for functions created without one, and a
// comment-less function anywhere in the account used to fail the decode with
// `SchemaError: Missing key ... FunctionConfig.Comment`.
test.provider(
  "list enumerates the deployed CloudFront Function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.CloudFront.Function("ListFn", {
            comment: "list handler",
            code: `async function handler(event) {
  return event.request;
}`,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Function);
      const all = yield* provider.list();

      expect(all.some((fn) => fn.functionName === deployed.functionName)).toBe(
        true,
      );

      yield* stack.destroy();
      yield* assertFunctionDeleted(deployed.functionName);
    }),
  { timeout: 300_000 },
);

const assertFunctionDeleted = (name: string) =>
  cloudfront
    .describeFunction({
      Name: name,
      Stage: "LIVE",
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new Error("FunctionStillExists"))),
      Effect.catchTag("NoSuchFunctionExists", () => Effect.void),
      Effect.retry({
        while: (error) =>
          error instanceof Error && error.message === "FunctionStillExists",
        schedule: Schedule.max([
          Schedule.fixed("5 seconds"),
          Schedule.recurs(24),
        ]),
      }),
    );
