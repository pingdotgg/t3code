import * as AWS from "@/AWS";
import { LifecyclePolicy } from "@/AWS/OpenSearchServerless";
import * as Test from "@/Test/Alchemy";
import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const POLICY_NAME = "alchemy-test-retention";

const retentionPolicy = (retention: string) => ({
  Rules: [
    {
      ResourceType: "index",
      Resource: ["index/alchemy-lp-test/*"],
      MinIndexRetention: retention,
    },
  ],
});

const observe = (name: string) =>
  aoss
    .batchGetLifecyclePolicy({ identifiers: [{ type: "retention", name }] })
    .pipe(Effect.map((r) => r.lifecyclePolicyDetails?.[0]));

const assertGone = (name: string) =>
  observe(name).pipe(
    Effect.flatMap((detail) =>
      detail === undefined
        ? Effect.void
        : Effect.fail(new Error(`lifecycle policy ${name} still exists`)),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(5)]),
    }),
  );

// Lifecycle policies are free and provision instantly, so the full lifecycle
// runs ungated: create, no-op, update (policy version bump), destroy, verify
// gone — all out-of-band verified via distilled.
test.provider(
  "lifecycle policy lifecycle: create, no-op, update, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const deployPolicy = (retention: string, description?: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const policy = yield* LifecyclePolicy("Retention", {
              policyName: POLICY_NAME,
              policy: retentionPolicy(retention),
              description,
            });
            return { policy };
          }),
        );

      // Create.
      const created = yield* deployPolicy("24h", "alchemy test retention");
      expect(created.policy.policyName).toBe(POLICY_NAME);
      expect(created.policy.type).toBe("retention");
      const initialVersion = created.policy.policyVersion;

      // Out-of-band verification via distilled.
      const observed = yield* observe(POLICY_NAME);
      expect(observed?.name).toBe(POLICY_NAME);
      expect(JSON.stringify(observed?.policy)).toContain("24h");

      // No-op redeploy: version must not change.
      const noop = yield* deployPolicy("24h", "alchemy test retention");
      expect(noop.policy.policyVersion).toBe(initialVersion);

      // Update the retention window → new policy version.
      const updated = yield* deployPolicy("48h", "alchemy test retention");
      expect(updated.policy.policyVersion).not.toBe(initialVersion);
      const observedUpdated = yield* observe(POLICY_NAME);
      expect(JSON.stringify(observedUpdated?.policy)).toContain("48h");

      // Destroy and verify deletion out-of-band.
      yield* stack.destroy();
      yield* assertGone(POLICY_NAME);
    }),
  { timeout: 120_000 },
);
