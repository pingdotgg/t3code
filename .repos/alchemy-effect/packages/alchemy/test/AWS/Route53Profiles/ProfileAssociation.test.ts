import * as AWS from "@/AWS";
import { Profile, ProfileAssociation } from "@/AWS/Route53Profiles";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as profiles from "@distilled.cloud/aws/route53profiles";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

const assertAssociationGone = (profileAssociationId: string) =>
  profiles
    .getProfileAssociation({ ProfileAssociationId: profileAssociationId })
    .pipe(
      Effect.flatMap((r) =>
        r.ProfileAssociation?.Status === "DELETING" ||
        r.ProfileAssociation?.Status === "DELETED"
          ? Effect.void
          : Effect.fail(
              new Error(`association still ${r.ProfileAssociation?.Status}`),
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

const assertProfileGone = (profileId: string) =>
  profiles.getProfile({ ProfileId: profileId }).pipe(
    Effect.flatMap((r) =>
      r.Profile?.Status === "DELETING" || r.Profile?.Status === "DELETED"
        ? Effect.void
        : Effect.fail(new Error(`profile still ${r.Profile?.Status}`)),
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
  "associate a Profile with a VPC and destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // A Profile association accepts any VPC in the Region. Use the
      // standing default VPC instead of consuming a scarce VPC quota slot;
      // because it is resolved outside the stack, destroy cannot delete it.
      const defaultVpc = yield* getDefaultVpc;

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* Profile("VpcDnsProfile", {});
          const association = yield* ProfileAssociation("VpcDns", {
            profileId: profile.profileId,
            resourceId: defaultVpc.vpcId,
          });
          return { profile, association };
        }),
      );

      expect(deployed.association.profileAssociationId).toMatch(/^rpassoc-/);
      expect(deployed.association.profileId).toBe(deployed.profile.profileId);
      expect(deployed.association.resourceId).toBe(defaultVpc.vpcId);

      // Out-of-band: the association exists for the (profile, VPC) pair.
      const live = yield* profiles.getProfileAssociation({
        ProfileAssociationId: deployed.association.profileAssociationId,
      });
      expect(live.ProfileAssociation?.ProfileId).toBe(
        deployed.profile.profileId,
      );
      expect(live.ProfileAssociation?.ResourceId).toBe(defaultVpc.vpcId);
      expect(["CREATING", "COMPLETE"]).toContain(
        live.ProfileAssociation?.Status,
      );

      // Re-deploying the same stack is a no-op (idempotent reconcile).
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* Profile("VpcDnsProfile", {});
          const association = yield* ProfileAssociation("VpcDns", {
            profileId: profile.profileId,
            resourceId: defaultVpc.vpcId,
          });
          return { association };
        }),
      );
      expect(again.association.profileAssociationId).toBe(
        deployed.association.profileAssociationId,
      );

      // Destroy tears down the association before the profile. The standing
      // default VPC is deliberately outside the stack and must remain.
      yield* stack.destroy();
      yield* assertAssociationGone(deployed.association.profileAssociationId);
      yield* assertProfileGone(deployed.profile.profileId);
      const vpcAfter = yield* ec2.describeVpcs({
        VpcIds: [defaultVpc.vpcId],
      });
      expect(vpcAfter.Vpcs?.[0]?.IsDefault).toBe(true);
    }),
  { timeout: 360_000 },
);
