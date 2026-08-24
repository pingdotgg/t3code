import * as AWS from "@/AWS";
import { RegistryPolicy } from "@/AWS/ECR";
import type { PolicyDocument } from "@/AWS/IAM/Policy.ts";
import { normalizePolicyDocument } from "@/AWS/IAM/Policy.ts";
import * as Test from "@/Test/Alchemy";
import * as ecr from "@distilled.cloud/aws/ecr";
import { Region } from "@distilled.cloud/aws/Region";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const readRegistryPolicy = ecr.getRegistryPolicy({}).pipe(
  Effect.map((response) => response.policyText),
  Effect.catchTag("RegistryPolicyNotFoundException", () =>
    Effect.succeed(undefined),
  ),
);

// The registry policy is an account/region SINGLETON — capture any
// pre-existing policy up front and restore it after the test so a shared
// testing account is left exactly as we found it.
test.provider(
  "PolicyDocument-valued registry policy deploys and re-deploys clean",
  (stack) =>
    Effect.gen(function* () {
      const prior = yield* readRegistryPolicy;

      const identity = yield* sts.getCallerIdentity({});
      const accountId = identity.Account!;
      const region = yield* yield* Region;

      const registryPolicy: PolicyDocument = {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AlchemyTestReplication",
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${accountId}:root` },
            Action: ["ecr:ReplicateImage"],
            Resource: `arn:aws:ecr:${region}:${accountId}:repository/*`,
          },
        ],
      };

      const run = Effect.gen(function* () {
        yield* stack.destroy();

        const deployPolicy = () =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* RegistryPolicy("TestRegistryPolicy", {
                policy: registryPolicy,
              });
            }),
          );

        const deployed = yield* deployPolicy();
        expect(deployed.registryId).toBe(accountId);

        // Out-of-band: the applied policy is equivalent to the structured
        // document (normalized comparison).
        const observed = yield* readRegistryPolicy;
        expect(observed).toBeDefined();
        expect(normalizePolicyDocument(observed!)).toBe(
          normalizePolicyDocument(registryPolicy),
        );

        // Re-deploy the identical PolicyDocument — must converge cleanly
        // (normalized observed vs desired no-ops the put).
        const again = yield* deployPolicy();
        expect(again.registryId).toBe(accountId);
        const observedAgain = yield* readRegistryPolicy;
        expect(normalizePolicyDocument(observedAgain!)).toBe(
          normalizePolicyDocument(registryPolicy),
        );

        yield* stack.destroy();
        expect(yield* readRegistryPolicy).toBeUndefined();
      });

      // Restore whatever registry policy existed before the test ran,
      // whether the body succeeded or failed.
      yield* run.pipe(
        Effect.ensuring(
          prior === undefined
            ? Effect.void
            : ecr.putRegistryPolicy({ policyText: prior }).pipe(Effect.ignore),
        ),
      );
    }),
  { timeout: 120_000 },
);
