import * as AWS from "@/AWS";
import type { PolicyDocument } from "@/AWS/IAM/Policy.ts";
import { EmailIdentity, EmailIdentityPolicy } from "@/AWS/SES";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const DOMAIN = "policy.alchemy-test.example.com";

// SES validates the policy document on write: Resource must be the identity's
// own ARN, not a wildcard ("BadRequestException: Invalid ARN: ARNs must start
// with 'arn:': *").
const allowPolicy = (sid: string, identityArn: string): PolicyDocument => ({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: sid,
      Effect: "Allow",
      Principal: { AWS: "*" },
      Action: ["ses:SendEmail"],
      Resource: identityArn,
    },
  ],
});

class PolicyStillExists extends Data.TaggedError("PolicyStillExists")<{
  readonly emailIdentity: string;
  readonly policyName: string;
}> {}

const assertPolicyDeleted = (emailIdentity: string, policyName: string) =>
  sesv2.getEmailIdentityPolicies({ EmailIdentity: emailIdentity }).pipe(
    Effect.flatMap((res) =>
      (res.Policies ?? {})[policyName] !== undefined
        ? Effect.fail(new PolicyStillExists({ emailIdentity, policyName }))
        : Effect.void,
    ),
    // A deleted identity takes its policies with it.
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "PolicyStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "identity policy lifecycle: create, update document, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { identity, policy } = yield* stack.deploy(
        Effect.gen(function* () {
          const identity = yield* EmailIdentity("PolicyIdentity", {
            emailIdentity: DOMAIN,
          });
          const policy = yield* EmailIdentityPolicy("Authz", {
            emailIdentity: identity.emailIdentity,
            policy: Output.all(identity.identityArn).pipe(
              Output.map(([arn]) => allowPolicy("AllowSend", arn)),
            ),
          });
          return { identity, policy };
        }),
      );

      expect(policy.emailIdentity).toBe(identity.emailIdentity);
      expect(policy.policyName).toBeDefined();

      // out-of-band verification via distilled
      const observed = yield* sesv2.getEmailIdentityPolicies({
        EmailIdentity: identity.emailIdentity,
      });
      expect(observed.Policies?.[policy.policyName]).toContain("AllowSend");

      // update the policy document in place (identity stays deployed)
      yield* stack.deploy(
        Effect.gen(function* () {
          const identity = yield* EmailIdentity("PolicyIdentity", {
            emailIdentity: DOMAIN,
          });
          yield* EmailIdentityPolicy("Authz", {
            emailIdentity: identity.emailIdentity,
            policy: Output.all(identity.identityArn).pipe(
              Output.map(([arn]) => allowPolicy("AllowSendUpdated", arn)),
            ),
          });
        }),
      );
      const updated = yield* sesv2.getEmailIdentityPolicies({
        EmailIdentity: identity.emailIdentity,
      });
      expect(updated.Policies?.[policy.policyName]).toContain(
        "AllowSendUpdated",
      );

      yield* stack.destroy();
      yield* assertPolicyDeleted(identity.emailIdentity, policy.policyName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "renaming the policy replaces it on the same identity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The identity stays deployed across the replacement so the engine never
      // removes a dependency of the resource being replaced.
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const identity = yield* EmailIdentity("RenamePolicyIdentity", {
            emailIdentity: DOMAIN,
          });
          const policy = yield* EmailIdentityPolicy("RenamePolicy", {
            emailIdentity: identity.emailIdentity,
            policyName: "alchemy-test-policy-a",
            policy: Output.all(identity.identityArn).pipe(
              Output.map(([arn]) => allowPolicy("A", arn)),
            ),
          });
          return {
            emailIdentity: identity.emailIdentity,
            policyName: policy.policyName,
          };
        }),
      );
      expect(first.policyName).toBe("alchemy-test-policy-a");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const identity = yield* EmailIdentity("RenamePolicyIdentity", {
            emailIdentity: DOMAIN,
          });
          const policy = yield* EmailIdentityPolicy("RenamePolicy", {
            emailIdentity: identity.emailIdentity,
            policyName: "alchemy-test-policy-b",
            policy: Output.all(identity.identityArn).pipe(
              Output.map(([arn]) => allowPolicy("B", arn)),
            ),
          });
          return {
            emailIdentity: identity.emailIdentity,
            policyName: policy.policyName,
          };
        }),
      );
      expect(second.policyName).toBe("alchemy-test-policy-b");
      yield* assertPolicyDeleted(first.emailIdentity, "alchemy-test-policy-a");

      yield* stack.destroy();
      yield* assertPolicyDeleted(second.emailIdentity, "alchemy-test-policy-b");
    }),
  { timeout: 120_000 },
);
