import * as AWS from "@/AWS";
import {
  AddonInstance,
  AddonSubscription,
  AddressList,
  Archive,
  IngressPoint,
  Relay,
  RuleSet,
  TrafficPolicy,
} from "@/AWS/MailManager";
import * as Test from "@/Test/Alchemy";
import * as mm from "@distilled.cloud/aws/mailmanager";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled error union carries the
// not-found tag every MailManager provider's read/delete path depends on.
// Runs in every CI pass at near-zero cost.
test.provider(
  "getRuleSet on a bogus id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        // Well-formed (rs- + 26 alphanumerics) but nonexistent — a malformed
        // id fails ValidationException before the existence check.
        mm.getRuleSet({ RuleSetId: "rs-00000000000000000000000000" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Mail Manager deletes are natively idempotent — deleting a nonexistent
// (well-formed) id SUCCEEDS rather than failing ResourceNotFoundException,
// which is why deleteRuleSet's error union carries no not-found tag and the
// providers' delete paths need no catch. This probe pins that behavior.
test.provider("deleteRuleSet on a nonexistent id succeeds (idempotent)", () =>
  Effect.gen(function* () {
    yield* mm.deleteRuleSet({ RuleSetId: "rs-00000000000000000000000000" });
    yield* mm.deleteTrafficPolicy({
      TrafficPolicyId: "tp-00000000000000000000000000",
    });
    expect(true).toBe(true);
  }),
);

// Rule sets and traffic policies are free, provision instantly, and need no
// verified domains — full lifecycle runs ungated. Relays are also free
// config-only resources (creation does not validate connectivity).
test.provider(
  "lifecycle: rule set + traffic policy + relay",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleSet = yield* RuleSet("Inbound", {
            rules: [{ Name: "DropAll", Actions: [{ Drop: {} }] }],
            tags: { fixture: "mailmanager" },
          });
          const trafficPolicy = yield* TrafficPolicy("Edge", {
            defaultAction: "ALLOW",
            policyStatements: [
              {
                Action: "DENY",
                Conditions: [
                  {
                    IpExpression: {
                      Evaluate: { Attribute: "SENDER_IP" },
                      Operator: "CIDR_MATCHES",
                      Values: ["192.0.2.0/24"],
                    },
                  },
                ],
              },
            ],
            maxMessageSizeBytes: 10_485_760,
            tags: { fixture: "mailmanager" },
          });
          const relay = yield* Relay("Downstream", {
            serverName: "smtp.example.com",
            serverPort: 25,
            authentication: { NoAuthentication: {} },
            tags: { fixture: "mailmanager" },
          });
          return { ruleSet, trafficPolicy, relay };
        }),
      );

      expect(deployed.ruleSet.ruleSetId).toBeDefined();
      expect(deployed.ruleSet.ruleSetArn).toContain("mailmanager");
      expect(deployed.trafficPolicy.trafficPolicyId).toBeDefined();
      expect(deployed.trafficPolicy.trafficPolicyArn).toContain("mailmanager");
      expect(deployed.relay.relayId).toBeDefined();
      expect(deployed.relay.relayArn).toContain("mailmanager");

      // Out-of-band verification via distilled.
      const liveRuleSet = yield* mm.getRuleSet({
        RuleSetId: deployed.ruleSet.ruleSetId,
      });
      expect(liveRuleSet.RuleSetName).toBe(deployed.ruleSet.ruleSetName);
      expect(liveRuleSet.Rules).toHaveLength(1);
      expect(liveRuleSet.Rules[0]?.Name).toBe("DropAll");

      const livePolicy = yield* mm.getTrafficPolicy({
        TrafficPolicyId: deployed.trafficPolicy.trafficPolicyId,
      });
      expect(livePolicy.DefaultAction).toBe("ALLOW");
      expect(livePolicy.MaxMessageSizeBytes).toBe(10_485_760);
      expect(livePolicy.PolicyStatements).toHaveLength(1);

      const liveRelay = yield* mm.getRelay({
        RelayId: deployed.relay.relayId,
      });
      expect(liveRelay.ServerName).toBe("smtp.example.com");
      expect(liveRelay.ServerPort).toBe(25);

      const ruleSetTags = yield* mm.listTagsForResource({
        ResourceArn: deployed.ruleSet.ruleSetArn,
      });
      expect(
        ruleSetTags.Tags?.some(
          (t) => t.Key === "alchemy::id" && t.Value === "Inbound",
        ),
      ).toBe(true);
      expect(
        ruleSetTags.Tags?.some(
          (t) => t.Key === "fixture" && t.Value === "mailmanager",
        ),
      ).toBe(true);

      // Update — rules, statements, relay port, and tags all change in
      // place; identities are stable.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleSet = yield* RuleSet("Inbound", {
            rules: [
              {
                Name: "DropSecret",
                Conditions: [
                  {
                    StringExpression: {
                      Evaluate: { Attribute: "SUBJECT" },
                      Operator: "CONTAINS",
                      Values: ["secret"],
                    },
                  },
                ],
                Actions: [{ Drop: {} }],
              },
              { Name: "DropRest", Actions: [{ Drop: {} }] },
            ],
            tags: { fixture: "mailmanager", env: "test" },
          });
          const trafficPolicy = yield* TrafficPolicy("Edge", {
            defaultAction: "DENY",
            policyStatements: [
              {
                Action: "ALLOW",
                Conditions: [
                  {
                    IpExpression: {
                      Evaluate: { Attribute: "SENDER_IP" },
                      Operator: "CIDR_MATCHES",
                      Values: ["198.51.100.0/24"],
                    },
                  },
                ],
              },
            ],
            maxMessageSizeBytes: 5_242_880,
            tags: { fixture: "mailmanager" },
          });
          const relay = yield* Relay("Downstream", {
            serverName: "smtp.example.com",
            serverPort: 587,
            authentication: { NoAuthentication: {} },
            tags: { fixture: "mailmanager" },
          });
          return { ruleSet, trafficPolicy, relay };
        }),
      );

      expect(updated.ruleSet.ruleSetId).toBe(deployed.ruleSet.ruleSetId);
      expect(updated.trafficPolicy.trafficPolicyId).toBe(
        deployed.trafficPolicy.trafficPolicyId,
      );
      expect(updated.relay.relayId).toBe(deployed.relay.relayId);

      const updatedRuleSet = yield* mm.getRuleSet({
        RuleSetId: updated.ruleSet.ruleSetId,
      });
      expect(updatedRuleSet.Rules).toHaveLength(2);
      const updatedPolicy = yield* mm.getTrafficPolicy({
        TrafficPolicyId: updated.trafficPolicy.trafficPolicyId,
      });
      expect(updatedPolicy.DefaultAction).toBe("DENY");
      expect(updatedPolicy.MaxMessageSizeBytes).toBe(5_242_880);
      const updatedRelay = yield* mm.getRelay({
        RelayId: updated.relay.relayId,
      });
      expect(updatedRelay.ServerPort).toBe(587);
      const updatedRuleSetTags = yield* mm.listTagsForResource({
        ResourceArn: updated.ruleSet.ruleSetArn,
      });
      expect(
        updatedRuleSetTags.Tags?.some(
          (t) => t.Key === "env" && t.Value === "test",
        ),
      ).toBe(true);

      // Destroy — everything gone, typed.
      yield* stack.destroy();
      const ruleSetError = yield* Effect.flip(
        mm.getRuleSet({ RuleSetId: updated.ruleSet.ruleSetId }),
      );
      expect(ruleSetError._tag).toBe("ResourceNotFoundException");
      const policyError = yield* Effect.flip(
        mm.getTrafficPolicy({
          TrafficPolicyId: updated.trafficPolicy.trafficPolicyId,
        }),
      );
      expect(policyError._tag).toBe("ResourceNotFoundException");
      const relayError = yield* Effect.flip(
        mm.getRelay({ RelayId: updated.relay.relayId }),
      );
      expect(relayError._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 240_000 },
);

// Address lists and archives are free and provision instantly — full
// lifecycle runs ungated. The destroy phase also pins the archive's
// PENDING_DELETION semantics (deleted archives tombstone for 30 days) and
// re-creates once to prove reruns don't collide with the tombstone.
test.provider(
  "lifecycle: address list + archive",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const addressList = yield* AddressList("Members", {
            tags: { fixture: "mailmanager" },
          });
          const archive = yield* Archive("Mail", {
            retentionPeriod: "THREE_MONTHS",
            tags: { fixture: "mailmanager" },
          });
          return { addressList, archive };
        }),
      );

      expect(deployed.addressList.addressListId).toBeDefined();
      expect(deployed.addressList.addressListArn).toContain("mailmanager");
      expect(deployed.archive.archiveId).toBeDefined();
      expect(deployed.archive.archiveArn).toContain("mailmanager");
      expect(deployed.archive.archiveState).toBe("ACTIVE");

      // Out-of-band verification via distilled.
      const liveList = yield* mm.getAddressList({
        AddressListId: deployed.addressList.addressListId,
      });
      expect(liveList.AddressListName).toBe(
        deployed.addressList.addressListName,
      );
      const liveArchive = yield* mm.getArchive({
        ArchiveId: deployed.archive.archiveId,
      });
      expect(liveArchive.ArchiveName).toBe(deployed.archive.archiveName);
      expect(liveArchive.Retention?.RetentionPeriod).toBe("THREE_MONTHS");
      const listTags = yield* mm.listTagsForResource({
        ResourceArn: deployed.addressList.addressListArn,
      });
      expect(
        listTags.Tags?.some(
          (t) => t.Key === "alchemy::id" && t.Value === "Members",
        ),
      ).toBe(true);

      // Update — archive retention changes in place; address list tags
      // sync; identities are stable.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const addressList = yield* AddressList("Members", {
            tags: { fixture: "mailmanager", env: "test" },
          });
          const archive = yield* Archive("Mail", {
            retentionPeriod: "SIX_MONTHS",
            tags: { fixture: "mailmanager" },
          });
          return { addressList, archive };
        }),
      );

      expect(updated.addressList.addressListId).toBe(
        deployed.addressList.addressListId,
      );
      expect(updated.archive.archiveId).toBe(deployed.archive.archiveId);
      const updatedArchive = yield* mm.getArchive({
        ArchiveId: updated.archive.archiveId,
      });
      expect(updatedArchive.Retention?.RetentionPeriod).toBe("SIX_MONTHS");
      const updatedListTags = yield* mm.listTagsForResource({
        ResourceArn: updated.addressList.addressListArn,
      });
      expect(
        updatedListTags.Tags?.some(
          (t) => t.Key === "env" && t.Value === "test",
        ),
      ).toBe(true);

      // Destroy — the list is gone (typed); the archive tombstones in
      // PENDING_DELETION (or is already invisible).
      yield* stack.destroy();
      const listError = yield* Effect.flip(
        mm.getAddressList({
          AddressListId: updated.addressList.addressListId,
        }),
      );
      expect(listError._tag).toBe("ResourceNotFoundException");
      const archiveState = yield* mm
        .getArchive({ ArchiveId: updated.archive.archiveId })
        .pipe(
          Effect.map((a) => a.ArchiveState),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed("PENDING_DELETION" as const),
          ),
        );
      expect(archiveState).toBe("PENDING_DELETION");

      // Re-create — proves a rerun does not collide with the
      // pending-deletion tombstone of the same deterministic name.
      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          const archive = yield* Archive("Mail", {
            retentionPeriod: "THREE_MONTHS",
          });
          return { archive };
        }),
      );
      expect(recreated.archive.archiveId).not.toBe(deployed.archive.archiveId);
      expect(recreated.archive.archiveState).toBe("ACTIVE");

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);

// Ingress points provision an SMTP endpoint asynchronously (~1-2 min each
// way) — the full lifecycle is gated behind AWS_TEST_MAILMANAGER=1.
const assertIngressPointGone = (ingressPointId: string) =>
  Effect.gen(function* () {
    const status = yield* mm
      .getIngressPoint({ IngressPointId: ingressPointId })
      .pipe(
        Effect.map((r) => r.Status ?? "unknown"),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed("gone" as const),
        ),
      );
    if (status !== "gone" && status !== "DEPROVISIONING") {
      return yield* Effect.fail(
        new Error(`ingress point still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(12),
      ]),
    }),
  );

test.provider.skipIf(!process.env.AWS_TEST_MAILMANAGER)(
  "lifecycle: open ingress point",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleSet = yield* RuleSet("IngressRules", {
            rules: [{ Name: "DropAll", Actions: [{ Drop: {} }] }],
          });
          const trafficPolicy = yield* TrafficPolicy("IngressPolicy", {
            defaultAction: "ALLOW",
          });
          const ingress = yield* IngressPoint("Smtp", {
            type: "OPEN",
            ruleSetId: ruleSet.ruleSetId,
            trafficPolicyId: trafficPolicy.trafficPolicyId,
            // An omitted TlsPolicy defaults to FIPS, and AWS rejects any
            // update from or to FIPS — start in the updatable regime.
            tlsPolicy: "REQUIRED",
            tags: { fixture: "mailmanager" },
          });
          return { ruleSet, trafficPolicy, ingress };
        }),
      );

      expect(deployed.ingress.ingressPointId).toBeDefined();
      expect(deployed.ingress.ingressPointArn).toContain("mailmanager");

      // Out-of-band verification via distilled.
      const live = yield* mm.getIngressPoint({
        IngressPointId: deployed.ingress.ingressPointId,
      });
      expect(live.Type).toBe("OPEN");
      expect(live.RuleSetId).toBe(deployed.ruleSet.ruleSetId);
      expect(live.TrafficPolicyId).toBe(deployed.trafficPolicy.trafficPolicyId);
      expect(live.TlsPolicy).toBe("REQUIRED");

      // Update in place — TLS policy changes REQUIRED -> OPTIONAL; identity
      // is stable. Both dependencies stay deployed (engine replace+remove
      // deadlock).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleSet = yield* RuleSet("IngressRules", {
            rules: [{ Name: "DropAll", Actions: [{ Drop: {} }] }],
          });
          const trafficPolicy = yield* TrafficPolicy("IngressPolicy", {
            defaultAction: "ALLOW",
          });
          const ingress = yield* IngressPoint("Smtp", {
            type: "OPEN",
            ruleSetId: ruleSet.ruleSetId,
            trafficPolicyId: trafficPolicy.trafficPolicyId,
            tlsPolicy: "OPTIONAL",
            tags: { fixture: "mailmanager" },
          });
          return { ingress };
        }),
      );

      expect(updated.ingress.ingressPointId).toBe(
        deployed.ingress.ingressPointId,
      );
      const updatedLive = yield* mm.getIngressPoint({
        IngressPointId: updated.ingress.ingressPointId,
      });
      expect(updatedLive.TlsPolicy).toBe("OPTIONAL");

      // Destroy — deletion is asynchronous; verify it is at least
      // irreversibly deprovisioning.
      yield* stack.destroy();
      yield* assertIngressPointGone(updated.ingress.ingressPointId);
    }),
  { timeout: 600_000 },
);

// Add On subscriptions accept third-party terms of use and ADDITIONAL
// PRICING — never created outside an explicitly opted-in account.
test.provider.skipIf(!process.env.AWS_TEST_MAILMANAGER_ADDONS)(
  "lifecycle: addon subscription + addon instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const subscription = yield* AddonSubscription("Spamhaus", {
            addonName: "SPAMHAUS_DBL",
            tags: { fixture: "mailmanager" },
          });
          const instance = yield* AddonInstance("SpamhausInstance", {
            addonSubscriptionId: subscription.addonSubscriptionId,
            tags: { fixture: "mailmanager" },
          });
          return { subscription, instance };
        }),
      );

      expect(deployed.subscription.addonSubscriptionId).toBeDefined();
      expect(deployed.subscription.addonName).toBe("SPAMHAUS_DBL");
      expect(deployed.instance.addonInstanceId).toBeDefined();
      expect(deployed.instance.addonSubscriptionId).toBe(
        deployed.subscription.addonSubscriptionId,
      );

      // Out-of-band verification via distilled.
      const liveSubscription = yield* mm.getAddonSubscription({
        AddonSubscriptionId: deployed.subscription.addonSubscriptionId,
      });
      expect(liveSubscription.AddonName).toBe("SPAMHAUS_DBL");
      const liveInstance = yield* mm.getAddonInstance({
        AddonInstanceId: deployed.instance.addonInstanceId,
      });
      expect(liveInstance.AddonSubscriptionId).toBe(
        deployed.subscription.addonSubscriptionId,
      );

      // Destroy — both gone, typed.
      yield* stack.destroy();
      const instanceError = yield* Effect.flip(
        mm.getAddonInstance({
          AddonInstanceId: deployed.instance.addonInstanceId,
        }),
      );
      expect(instanceError._tag).toBe("ResourceNotFoundException");
      const subscriptionError = yield* Effect.flip(
        mm.getAddonSubscription({
          AddonSubscriptionId: deployed.subscription.addonSubscriptionId,
        }),
      );
      expect(subscriptionError._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 240_000 },
);
