import * as AWS from "@/AWS";
import { ResourcePolicy } from "@/AWS/XRay";
import * as Test from "@/Test/Alchemy";
import * as xray from "@distilled.cloud/aws/xray";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const findPolicy = (policyName: string) =>
  xray.listResourcePolicies.items({}).pipe(
    Stream.filter((policy) => policy.PolicyName === policyName),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

class PolicyStillExists extends Data.TaggedError("PolicyStillExists")<{
  readonly policyName: string;
}> {}

const assertPolicyDeleted = (policyName: string) =>
  findPolicy(policyName).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(new PolicyStillExists({ policyName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "PolicyStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

const policyDocument = (actions: string[]) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "sns.amazonaws.com" },
        Action: actions,
        Resource: "*",
      },
    ],
  });

test.provider(
  "create, update document, delete resource policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ResourcePolicy("TestResourcePolicy", {
            policyDocument: policyDocument(["xray:PutTraceSegments"]),
          });
        }),
      );

      expect(created.policyName).toBeDefined();
      expect(created.policyRevisionId).toBeDefined();

      // out-of-band verification via distilled
      const live = yield* findPolicy(created.policyName);
      expect(live?.PolicyDocument).toContain("xray:PutTraceSegments");

      // update the document in place (same name, new statement)
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ResourcePolicy("TestResourcePolicy", {
            policyDocument: policyDocument([
              "xray:PutTraceSegments",
              "xray:GetSamplingRules",
            ]),
          });
        }),
      );
      expect(updated.policyName).toBe(created.policyName);
      expect(updated.policyRevisionId).not.toBe(created.policyRevisionId);

      const liveUpdated = yield* findPolicy(created.policyName);
      expect(liveUpdated?.PolicyDocument).toContain("xray:GetSamplingRules");

      // re-deploy with the same document — a no-op that keeps the revision
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ResourcePolicy("TestResourcePolicy", {
            policyDocument: policyDocument([
              "xray:PutTraceSegments",
              "xray:GetSamplingRules",
            ]),
          });
        }),
      );
      expect(noop.policyRevisionId).toBe(updated.policyRevisionId);

      yield* stack.destroy();
      yield* assertPolicyDeleted(created.policyName);
    }).pipe(
      Effect.ensuring(
        stack.destroy().pipe(Effect.catchCause(() => Effect.void)),
      ),
    ),
  { timeout: 120_000 },
);
