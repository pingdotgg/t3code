import * as AWS from "@alchemy.run/aws";
import { Function } from "@alchemy.run/aws/CloudFront";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
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
        current.FunctionSummary?.FunctionConfig.KeyValueStoreAssociations?.Items?.[0]
          ?.KeyValueStoreARN,
      ).toEqual(deployed.store.keyValueStoreArn);

      yield* stack.destroy();
      yield* assertFunctionDeleted(deployed.fn.functionName);
    }),
  {
    tags: ["provider:aws", "provider:aws:cloudfront", "live"],
    timeout: 300_000,
  },
);

// `FunctionConfig.Comment` is patched optional in
// submodules/distilled/packages/aws/patches/cloudfront.json — CloudFront omits `Comment`
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

      expect(all.some((fn) => fn.functionName === deployed.functionName)).toBe(true);

      yield* stack.destroy();
      yield* assertFunctionDeleted(deployed.functionName);
    }),
  {
    tags: ["provider:aws", "provider:aws:cloudfront", "live"],
    timeout: 300_000,
  },
);

// Regression for #2349: a function's `Status` is rollout state. It reads
// `UNASSOCIATED` until a distribution uses it, `IN_PROGRESS` right after a
// publish, and `DEPLOYED` once CloudFront finishes the rollout. Drift must not
// report a change when only that status moved.
test.provider.skipIf(!!process.env.FAST)(
  "drift reports no change once an associated function finishes rolling out",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (body: string) =>
        Effect.gen(function* () {
          const fn = yield* AWS.CloudFront.Function("RolloutFn", {
            comment: "rollout handler",
            code: `async function handler(event) {
  ${body}
  return event.request;
}`,
          });
          const distribution = yield* AWS.CloudFront.Distribution("RolloutDistribution", {
            origins: [
              {
                id: "site",
                domainName: "example.com",
                customOriginConfig: { originProtocolPolicy: "https-only" },
              },
            ],
            defaultCacheBehavior: {
              targetOriginId: "site",
              viewerProtocolPolicy: "redirect-to-https",
              functionAssociations: [{ functionArn: fn.functionArn, eventType: "viewer-request" }],
            },
          });
          return { fn, distribution };
        });

      const expectNoFunctionDrift = Effect.gen(function* () {
        const live = yield* cloudfront
          .describeFunction({ Name: deployed.fn.functionName, Stage: "LIVE" })
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (fn) => fn.FunctionSummary?.Status === "DEPLOYED",
              times: 60,
            }),
          );
        expect(live.FunctionSummary?.Status).toBe("DEPLOYED");

        const drift = yield* Drift.detect({ name: stack.name, stage: stack.stage }).pipe(
          Effect.provide(stack.state),
        );
        expect(drift.resources.RolloutFn?.action).toBe("unchanged");
      });

      const deployed = yield* stack.deploy(program("// v1"));
      yield* expectNoFunctionDrift;

      // A code change re-publishes LIVE, which starts a new rollout.
      yield* stack.deploy(program("// v2"));
      yield* expectNoFunctionDrift;

      yield* stack.destroy();
      yield* assertFunctionDeleted(deployed.fn.functionName);
    }),
  {
    tags: ["provider:aws", "provider:aws:cloudfront", "live"],
    timeout: 900_000,
  },
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
        while: (error) => error instanceof Error && error.message === "FunctionStillExists",
        schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(24)]),
      }),
    );
