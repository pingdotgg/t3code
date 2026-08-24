import * as AWS from "@/AWS";
import { Profile, ProfileResourceAssociation } from "@/AWS/Route53Profiles";
import * as Test from "@/Test/Alchemy";
import * as profiles from "@distilled.cloud/aws/route53profiles";
import * as resolver from "@distilled.cloud/aws/route53resolver";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const FRG_NAME = "alchemy-test-r53p-frg";

// The DNS Firewall rule group under test is created out-of-band via
// distilled (free, instant, and not the resource under test). Creation is
// idempotent via a deterministic CreatorRequestId; a leaked group from a
// prior crashed run is reused.
const ensureFirewallRuleGroup = Effect.gen(function* () {
  const existing = yield* resolver.listFirewallRuleGroups({});
  const found = existing.FirewallRuleGroups?.find((g) => g.Name === FRG_NAME);
  if (found?.Arn !== undefined && found.Id !== undefined) {
    return { arn: found.Arn, id: found.Id };
  }
  const created = yield* resolver.createFirewallRuleGroup({
    CreatorRequestId: FRG_NAME,
    Name: FRG_NAME,
  });
  return {
    arn: created.FirewallRuleGroup!.Arn!,
    id: created.FirewallRuleGroup!.Id!,
  };
});

// Deleting the rule group races the association's asynchronous drain.
const deleteFirewallRuleGroup = (id: string) =>
  resolver.deleteFirewallRuleGroup({ FirewallRuleGroupId: id }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ConflictException",
      schedule: Schedule.max([
        Schedule.fixed("4 seconds"),
        Schedule.recurs(15),
      ]),
    }),
    Effect.asVoid,
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );

const assertAssociationGone = (profileResourceAssociationId: string) =>
  profiles
    .getProfileResourceAssociation({
      ProfileResourceAssociationId: profileResourceAssociationId,
    })
    .pipe(
      Effect.flatMap((r) =>
        r.ProfileResourceAssociation?.Status === "DELETING" ||
        r.ProfileResourceAssociation?.Status === "DELETED"
          ? Effect.void
          : Effect.fail(
              new Error(
                `association still ${r.ProfileResourceAssociation?.Status}`,
              ),
            ),
      ),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      Effect.retry({
        while: (e) => e instanceof Error,
        schedule: Schedule.max([
          Schedule.fixed("3 seconds"),
          Schedule.recurs(10),
        ]),
      }),
    );

test.provider(
  "attach a DNS Firewall rule group, update its priority, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const ruleGroup = yield* ensureFirewallRuleGroup;

      const deploy = (priority: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const profile = yield* Profile("FirewallProfile", {});
            const attachment = yield* ProfileResourceAssociation(
              "FirewallRules",
              {
                profileId: profile.profileId,
                resourceArn: ruleGroup.arn,
                resourceProperties: JSON.stringify({ priority }),
              },
            );
            return { profile, attachment };
          }),
        );

      yield* Effect.gen(function* () {
        const first = yield* deploy(102);
        expect(first.attachment.profileResourceAssociationId).toMatch(/^rpr-/);
        expect(first.attachment.resourceArn).toBe(ruleGroup.arn);
        expect(first.attachment.resourceType).toBe("FIREWALL_RULE_GROUP");
        expect(JSON.parse(first.attachment.resourceProperties ?? "{}")).toEqual(
          { priority: 102 },
        );

        // Out-of-band: association exists with the requested priority.
        const live = yield* profiles.getProfileResourceAssociation({
          ProfileResourceAssociationId:
            first.attachment.profileResourceAssociationId,
        });
        expect(
          JSON.parse(
            live.ProfileResourceAssociation?.ResourceProperties ?? "{}",
          ),
        ).toEqual({ priority: 102 });

        // Priority updates in place — same association id.
        const second = yield* deploy(103);
        expect(second.attachment.profileResourceAssociationId).toBe(
          first.attachment.profileResourceAssociationId,
        );
        const updated = yield* profiles.getProfileResourceAssociation({
          ProfileResourceAssociationId:
            second.attachment.profileResourceAssociationId,
        });
        expect(
          JSON.parse(
            updated.ProfileResourceAssociation?.ResourceProperties ?? "{}",
          ),
        ).toEqual({ priority: 103 });

        yield* stack.destroy();
        yield* assertAssociationGone(
          first.attachment.profileResourceAssociationId,
        );
      }).pipe(
        // Always clean up the out-of-band rule group, even on failure.
        Effect.ensuring(
          deleteFirewallRuleGroup(ruleGroup.id).pipe(Effect.ignore),
        ),
      );
    }),
  { timeout: 360_000 },
);
