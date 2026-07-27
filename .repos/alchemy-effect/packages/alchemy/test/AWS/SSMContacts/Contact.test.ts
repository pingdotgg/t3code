import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Contact } from "@/AWS/SSMContacts/Contact.ts";
import { ContactChannel } from "@/AWS/SSMContacts/ContactChannel.ts";
import { Plan } from "@/AWS/SSMContacts/Plan.ts";
import { Rotation } from "@/AWS/SSMContacts/Rotation.ts";
import * as Test from "@/Test/Alchemy";
import * as contacts from "@distilled.cloud/aws/ssm-contacts";
import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// tags this provider's read/delete paths depend on. On an account that has
// not onboarded Incident Manager, every ssm-contacts call fails with the
// synthetic `IncidentManagerNotOnboarded` tag (patched from the overloaded
// ValidationException "Account not found for the request"); once onboarded,
// a missing contact is a plain `ResourceNotFoundException`.
test.provider(
  "getContact on a nonexistent contact fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        contacts.getContact({
          ContactId: `arn:aws:ssm-contacts:${region}:${accountId}:contact/alchemy-nonexistent-probe`,
        }),
      );
      expect([
        "ResourceNotFoundException",
        "IncidentManagerNotOnboarded",
      ]).toContain(error._tag);
    }),
);

// Contacts require the Incident Manager replication set (the account
// singleton that AWS.SSMIncidents.ReplicationSet manages). Ensure it exists
// and is ACTIVE; if we create it here we intentionally LEAVE it in place —
// offboarding Incident Manager account-wide is only exercised by the gated
// ReplicationSet lifecycle test. Returns the replication set ARN, or
// `undefined` when the account cannot be onboarded: AWS deprecated
// CreateReplicationSet on Nov 7, 2025, so only accounts that were already
// onboarded can exercise the contacts lifecycle.
const ensureReplicationSet = Effect.gen(function* () {
  const listed = yield* incidents.listReplicationSets({});
  let arn = listed.replicationSetArns[0];
  if (arn === undefined) {
    const { region } = yield* AWSEnvironment.current;
    const created = yield* Effect.result(
      incidents.createReplicationSet({ regions: { [region]: {} } }),
    );
    if (Result.isFailure(created)) {
      expect(created.failure._tag).toBe("UnsupportedOperationException");
      return undefined;
    }
    arn = created.success.arn;
  }
  const status = yield* incidents.getReplicationSet({ arn }).pipe(
    Effect.map((r) => r.replicationSet.status),
    Effect.repeat({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(60),
      ]),
      until: (status) => status !== "CREATING" && status !== "UPDATING",
    }),
  );
  expect(status).toBe("ACTIVE");
  return arn;
});

// Contact / ContactChannel / Plan / Rotation are cheap once the replication
// set exists, but they depend on that account-wide singleton — gate the whole
// lifecycle behind AWS_TEST_INCIDENT_MANAGER=1.
test.provider.skipIf(!process.env.AWS_TEST_INCIDENT_MANAGER)(
  "lifecycle: contact + channel + engagement plan + rotation",
  (stack) =>
    Effect.gen(function* () {
      const replicationSetArn = yield* ensureReplicationSet;
      if (replicationSetArn === undefined) {
        yield* Effect.logInfo(
          "CreateReplicationSet is deprecated (Nov 7, 2025) and this account is not onboarded to Incident Manager — skipping contacts lifecycle",
        );
        return;
      }
      yield* stack.destroy();

      // Create — a personal contact with a deferred-activation email channel,
      // a staged engagement plan targeting that channel, and a daily rotation.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const oncall = yield* Contact("Oncall", {
            type: "PERSONAL",
            displayName: "Primary On-Call",
            tags: { fixture: "ssm-contacts" },
          });
          const email = yield* ContactChannel("Email", {
            contactId: oncall.contactArn,
            type: "EMAIL",
            deliveryAddress: { SimpleAddress: "oncall@example.com" },
            deferActivation: true,
          });
          const plan = yield* Plan("OncallPlan", {
            contactId: oncall.contactArn,
            stages: [
              {
                DurationInMinutes: 5,
                Targets: [
                  {
                    ChannelTargetInfo: {
                      ContactChannelId: email.contactChannelArn,
                      RetryIntervalInMinutes: 1,
                    },
                  },
                ],
              },
            ],
          });
          const rotation = yield* Rotation("Primary", {
            contactIds: [oncall.contactArn],
            timeZoneId: "America/Los_Angeles",
            startTime: "2030-01-01T00:00:00Z",
            recurrence: {
              NumberOfOnCalls: 1,
              RecurrenceMultiplier: 1,
              DailySettings: [{ HourOfDay: 9, MinuteOfHour: 0 }],
            },
            tags: { fixture: "ssm-contacts" },
          });
          return { oncall, email, plan, rotation };
        }),
      );

      expect(deployed.oncall.contactArn).toContain(":contact/");
      expect(deployed.oncall.type).toBe("PERSONAL");
      expect(deployed.email.contactChannelArn).toContain(":contact-channel/");
      expect(deployed.email.activationStatus).toBe("NOT_ACTIVATED");
      expect(deployed.plan.stageCount).toBe(1);
      expect(deployed.rotation.rotationArn).toContain(":rotation/");

      // Out-of-band verification via distilled.
      const liveContact = yield* contacts.getContact({
        ContactId: deployed.oncall.contactArn,
      });
      expect(liveContact.Alias).toBe(deployed.oncall.alias);
      expect(liveContact.DisplayName).toBe("Primary On-Call");
      expect(liveContact.Plan.Stages).toHaveLength(1);
      const contactTags = yield* contacts.listTagsForResource({
        ResourceARN: deployed.oncall.contactArn,
      });
      expect(
        contactTags.Tags?.some(
          (t) => t.Key === "alchemy::id" && t.Value === "Oncall",
        ),
      ).toBe(true);

      const liveChannel = yield* contacts.getContactChannel({
        ContactChannelId: deployed.email.contactChannelArn,
      });
      expect(liveChannel.Type).toBe("EMAIL");
      expect(liveChannel.DeliveryAddress.SimpleAddress).toBe(
        "oncall@example.com",
      );

      const liveRotation = yield* contacts.getRotation({
        RotationId: deployed.rotation.rotationArn,
      });
      expect(liveRotation.TimeZoneId).toBe("America/Los_Angeles");
      expect(liveRotation.Recurrence.DailySettings?.[0]?.HourOfDay).toBe(9);

      // Update — display name, channel address, plan stage duration, and
      // rotation hand-off time all update in place; a resource policy is
      // attached (put/getContactPolicy sync).
      const { accountId } = yield* AWSEnvironment.current;
      const sharePolicy = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: accountId },
            Action: ["ssm-contacts:GetContact"],
            Resource: [
              deployed.oncall.contactArn,
              `${deployed.oncall.contactArn.replace(":contact/", ":engagement/")}/*`,
            ],
          },
        ],
      };
      yield* stack.deploy(
        Effect.gen(function* () {
          const oncall = yield* Contact("Oncall", {
            type: "PERSONAL",
            displayName: "Secondary On-Call",
            policy: sharePolicy,
            tags: { fixture: "ssm-contacts", env: "test" },
          });
          const email = yield* ContactChannel("Email", {
            contactId: oncall.contactArn,
            type: "EMAIL",
            deliveryAddress: { SimpleAddress: "standby@example.com" },
            deferActivation: true,
          });
          const plan = yield* Plan("OncallPlan", {
            contactId: oncall.contactArn,
            stages: [
              {
                DurationInMinutes: 10,
                Targets: [
                  {
                    ChannelTargetInfo: {
                      ContactChannelId: email.contactChannelArn,
                      RetryIntervalInMinutes: 2,
                    },
                  },
                ],
              },
            ],
          });
          const rotation = yield* Rotation("Primary", {
            contactIds: [oncall.contactArn],
            timeZoneId: "America/Los_Angeles",
            startTime: "2030-01-01T00:00:00Z",
            recurrence: {
              NumberOfOnCalls: 1,
              RecurrenceMultiplier: 1,
              DailySettings: [{ HourOfDay: 10, MinuteOfHour: 30 }],
            },
            tags: { fixture: "ssm-contacts" },
          });
          return { oncall, email, plan, rotation };
        }),
      );

      const updatedContact = yield* contacts.getContact({
        ContactId: deployed.oncall.contactArn,
      });
      expect(updatedContact.DisplayName).toBe("Secondary On-Call");
      expect(updatedContact.Plan.Stages?.[0]?.DurationInMinutes).toBe(10);
      const updatedChannel = yield* contacts.getContactChannel({
        ContactChannelId: deployed.email.contactChannelArn,
      });
      expect(updatedChannel.DeliveryAddress.SimpleAddress).toBe(
        "standby@example.com",
      );
      const updatedRotation = yield* contacts.getRotation({
        RotationId: deployed.rotation.rotationArn,
      });
      expect(updatedRotation.Recurrence.DailySettings?.[0]?.HourOfDay).toBe(10);
      const updatedTags = yield* contacts.listTagsForResource({
        ResourceARN: deployed.oncall.contactArn,
      });
      expect(
        updatedTags.Tags?.some((t) => t.Key === "env" && t.Value === "test"),
      ).toBe(true);
      const updatedPolicy = yield* contacts.getContactPolicy({
        ContactArn: deployed.oncall.contactArn,
      });
      expect(updatedPolicy.Policy).toContain("ssm-contacts:GetContact");

      // Destroy — everything but the account-singleton replication set.
      yield* stack.destroy();
      const contactError = yield* Effect.flip(
        contacts.getContact({ ContactId: deployed.oncall.contactArn }),
      );
      expect(contactError._tag).toBe("ResourceNotFoundException");
      const rotationError = yield* Effect.flip(
        contacts.getRotation({ RotationId: deployed.rotation.rotationArn }),
      );
      expect(rotationError._tag).toBe("ResourceNotFoundException");
    }),
  // ensureReplicationSet may onboard Incident Manager (~1-2 min) on first run.
  { timeout: 600_000 },
);
