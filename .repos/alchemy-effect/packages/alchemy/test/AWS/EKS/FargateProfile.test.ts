import * as AWS from "@/AWS";
import { FargateProfile } from "@/AWS/EKS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as eks from "@distilled.cloud/aws/eks";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: `describeFargateProfile` against a cluster that
// does not exist must surface the `ResourceNotFoundException` tag that the
// provider's read/reconcile/delete paths catch. Proves the distilled error
// union without needing a ~10-minute EKS cluster.
test.provider(
  "describeFargateProfile on a nonexistent cluster fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        eks.describeFargateProfile({
          clusterName: "alchemy-nonexistent-cluster-probe",
          fargateProfileName: "alchemy-nonexistent-profile-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Ungated `list()` probe: enumerates every cluster, lists each cluster's Fargate
// profiles, then hydrates each via `describeFargateProfile`. Returns `[]` in a
// clean account/region, otherwise a well-formed array of full FargateProfile
// Attributes. Proves the enumeration wiring compiles and runs live.
test.provider("list returns a well-formed array of Fargate profiles", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(FargateProfile);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const profile of all) {
      expect(typeof profile.fargateProfileArn).toBe("string");
      expect(typeof profile.fargateProfileName).toBe("string");
      expect(typeof profile.clusterName).toBe("string");
      expect(typeof profile.podExecutionRoleArn).toBe("string");
      expect(Array.isArray(profile.subnets)).toBe(true);
      expect(Array.isArray(profile.selectors)).toBe(true);
    }
  }),
);

// Full deploy lifecycle. Gate behind a pre-existing cluster supplied via
// AWS_TEST_EKS_CLUSTER (+ the Fargate pod execution role ARN and PRIVATE subnet
// IDs — Fargate pods reject public subnets). Deploys a Fargate profile, waits
// for ACTIVE, then tears down and asserts it is gone.
test.provider.skipIf(!process.env.AWS_TEST_EKS_CLUSTER)(
  "creates and deletes a Fargate profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clusterName = process.env.AWS_TEST_EKS_CLUSTER!;
      const podExecutionRoleArn = process.env.AWS_TEST_EKS_FARGATE_ROLE_ARN!;
      const subnets = (process.env.AWS_TEST_EKS_PRIVATE_SUBNETS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* FargateProfile("TestFargateProfile", {
            clusterName,
            podExecutionRoleArn,
            subnets,
            selectors: [{ namespace: "alchemy-fargate-test" }],
          });
        }),
      );
      expect(created.status).toBe("ACTIVE");
      expect(created.selectors[0]?.namespace).toBe("alchemy-fargate-test");

      yield* stack.destroy();

      const gone = yield* eks
        .describeFargateProfile({
          clusterName,
          fargateProfileName: created.fargateProfileName,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 900_000 },
);
