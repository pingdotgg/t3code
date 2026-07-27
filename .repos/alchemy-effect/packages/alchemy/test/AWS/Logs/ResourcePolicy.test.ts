import * as AWS from "@/AWS";
import type { PolicyDocument } from "@/AWS/IAM/Policy.ts";
import { ResourcePolicy } from "@/AWS/Logs/ResourcePolicy.ts";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// CAUTION: at most 10 resource policies per region per account. This suite
// uses ONE deterministic policy name and guarantees deletion via
// stack.destroy() at the start, at the end, and on error — never leak.
const POLICY_NAME = "alchemy-test-logs-resource-policy";

const findPolicy = Effect.fn(function* (policyName: string) {
  // quota is 10 policies per region — one call is exhaustive
  const described = yield* logs.describeResourcePolicies({ limit: 50 });
  return (described.resourcePolicies ?? []).find(
    (policy) => policy.policyName === policyName,
  );
});

class ResourcePolicyStillExists extends Data.TaggedError(
  "ResourcePolicyStillExists",
)<{ readonly policyName: string }> {}

const assertPolicyDeleted = (policyName: string) =>
  findPolicy(policyName).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(new ResourcePolicyStillExists({ policyName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "ResourcePolicyStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

const route53Document = (sid: string): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: sid,
      Effect: "Allow",
      Principal: { Service: "route53.amazonaws.com" },
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: ["arn:aws:logs:*:*:log-group:/aws/route53/alchemy-test-*"],
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
          return yield* ResourcePolicy("Route53QueryLogging", {
            policyName: POLICY_NAME,
            policyDocument: route53Document("AlchemyTestV1"),
          });
        }),
      );

      expect(created.policyName).toBe(POLICY_NAME);

      // out-of-band verification via distilled
      const observedCreated = yield* findPolicy(POLICY_NAME);
      expect(observedCreated?.policyDocument).toContain("AlchemyTestV1");
      expect(observedCreated?.policyDocument).toContain(
        "route53.amazonaws.com",
      );

      // update the document in place (same policy name)
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ResourcePolicy("Route53QueryLogging", {
            policyName: POLICY_NAME,
            policyDocument: route53Document("AlchemyTestV2"),
          });
        }),
      );
      expect(updated.policyName).toBe(POLICY_NAME);

      const observedUpdated = yield* findPolicy(POLICY_NAME);
      expect(observedUpdated?.policyDocument).toContain("AlchemyTestV2");

      yield* stack.destroy();
      yield* assertPolicyDeleted(POLICY_NAME);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { timeout: 120_000 },
);
