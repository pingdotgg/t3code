import * as AWS from "@/AWS";
import { EIP } from "@/AWS/EC2";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Protection, ProtectionGroup } from "@/AWS/Shield";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as shield from "@distilled.cloud/aws/shield";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Shield Advanced costs $3,000/month with a mandatory 1-year auto-renewing
// commitment, so the testing account is NOT subscribed and must never be. The
// ungated probes below prove the distilled wiring and the patched typed
// `SubscriptionNotFound` entitlement tag against the real API at near-zero
// cost; the full lifecycle only runs on an already-subscribed account with
// AWS_TEST_SHIELD_ADVANCED=1.
describe("AWS.Shield", () => {
  test.provider(
    "getSubscriptionState succeeds without a subscription",
    () =>
      Effect.gen(function* () {
        // Available to every account, subscribed or not — proves endpoint
        // resolution (shield pins to us-east-1) and response decoding.
        const state = yield* shield.getSubscriptionState({});
        expect(["ACTIVE", "INACTIVE"]).toContain(state.SubscriptionState);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "describeSubscription on a non-subscribed account fails with typed SubscriptionNotFound",
    () =>
      Effect.gen(function* () {
        // The entitlement probe: the wire error is ResourceNotFoundException
        // "The subscription does not exist." — patched in distilled to the
        // synthetic typed tag `SubscriptionNotFound`.
        const error = yield* Effect.flip(shield.describeSubscription({}));
        expect(error._tag).toBe("SubscriptionNotFound");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "describeProtection without a subscription fails with typed SubscriptionNotFound",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          shield.describeProtection({
            ProtectionId: "00000000-0000-0000-0000-000000000000",
          }),
        );
        expect(error._tag).toBe("SubscriptionNotFound");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "listProtections without a subscription fails with typed SubscriptionNotFound",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(shield.listProtections({}));
        expect(error._tag).toBe("SubscriptionNotFound");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "describeProtectionGroup for a nonexistent group fails with typed ResourceNotFoundException",
    () =>
      Effect.gen(function* () {
        // Unlike the other operations, protection-group reads report the
        // missing group itself even on a non-subscribed account.
        const error = yield* Effect.flip(
          shield.describeProtectionGroup({
            ProtectionGroupId: "alchemy-nonexistent-probe",
          }),
        );
        expect(error._tag).toBe("ResourceNotFoundException");
      }),
    { timeout: 60_000 },
  );

  // Full lifecycle — requires an account with an ACTIVE Shield Advanced
  // subscription. NEVER subscribe the testing account: deploying the
  // Shield.Subscription resource starts a $3,000/month 1-year commitment.
  test.provider.skipIf(!process.env.AWS_TEST_SHIELD_ADVANCED)(
    "protection + protection group lifecycle on a subscribed account",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deploy = (aggregation: "SUM" | "MAX") =>
          stack.deploy(
            Effect.gen(function* () {
              const { accountId, region } = yield* AWSEnvironment.current;
              const eip = yield* EIP("ProtectedEip", {});
              const protection = yield* Protection("EipProtection", {
                resourceArn: Output.interpolate`arn:aws:ec2:${region}:${accountId}:eip-allocation/${eip.allocationId}`,
                tags: { fixture: "shield" },
              });
              const group = yield* ProtectionGroup("AllGroup", {
                aggregation,
                pattern: "ALL",
                tags: { fixture: "shield" },
              });
              return { protection, group };
            }),
          );

        const { protection, group } = yield* deploy("SUM");
        expect(protection.protectionId).toBeDefined();
        expect(protection.protectionArn).toContain(":protection/");
        expect(protection.healthCheckIds).toEqual([]);
        expect(group.aggregation).toBe("SUM");
        expect(group.pattern).toBe("ALL");

        // Out-of-band verification via distilled.
        const observed = yield* shield.describeProtection({
          ProtectionId: protection.protectionId,
        });
        expect(observed.Protection?.ResourceArn).toBe(protection.resourceArn);
        const observedGroup = yield* shield.describeProtectionGroup({
          ProtectionGroupId: group.protectionGroupId,
        });
        expect(observedGroup.ProtectionGroup.Aggregation).toBe("SUM");

        // Update the group's aggregation in place (no replacement).
        const updated = yield* deploy("MAX");
        expect(updated.group.protectionGroupId).toBe(group.protectionGroupId);
        expect(updated.group.aggregation).toBe("MAX");

        // Destroy and verify both are gone out-of-band.
        yield* stack.destroy();
        const goneProtection = yield* Effect.flip(
          shield.describeProtection({
            ProtectionId: protection.protectionId,
          }),
        );
        expect(["ResourceNotFoundException", "SubscriptionNotFound"]).toContain(
          goneProtection._tag,
        );
        const goneGroup = yield* Effect.flip(
          shield.describeProtectionGroup({
            ProtectionGroupId: group.protectionGroupId,
          }),
        );
        expect(goneGroup._tag).toBe("ResourceNotFoundException");
      }),
    { timeout: 300_000 },
  );
});
