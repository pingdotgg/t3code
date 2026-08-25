import * as AWS from "@/AWS";
import { PhoneNumber } from "@/AWS/PinpointSMSVoiceV2";
import * as Test from "@/Test/Alchemy";
import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/observe/delete paths depend on.
test.provider(
  "describePhoneNumbers on a nonexistent ID fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        smsvoice.describePhoneNumbers({
          PhoneNumberIds: ["phone-ffffffffffffffffffffffffffffffff"],
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

const getById = (phoneNumberId: string) =>
  smsvoice.describePhoneNumbers({ PhoneNumberIds: [phoneNumberId] }).pipe(
    Effect.map((r) => r.PhoneNumbers?.[0]),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

const assertPhoneNumberGone = (phoneNumberId: string) =>
  Effect.gen(function* () {
    const found = yield* getById(phoneNumberId);
    // A released number lingers briefly in DISASSOCIATING before vanishing.
    if (found !== undefined && found.Status !== "DISASSOCIATING") {
      return yield* Effect.fail(
        new Error(
          `phone number '${phoneNumberId}' still exists (status: ${found.Status})`,
        ),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Requesting even a SIMULATOR number incurs a (small) monthly leasing fee
// and consumes account quota, so the lifecycle is gated behind
// AWS_TEST_PINPOINT_SMS=1 and always releases what it leased.
test.provider.skipIf(!process.env.AWS_TEST_PINPOINT_SMS)(
  "request a SIMULATOR number, update, and release it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const props = {
        isoCountryCode: "US",
        messageType: "TRANSACTIONAL" as const,
        numberCapabilities: ["SMS"],
        numberType: "SIMULATOR",
        tags: { fixture: "smsvoice-phone-number" },
      };

      // Create.
      const created = yield* stack.deploy(PhoneNumber("TestNumber", props));
      expect(created.phoneNumberId).toContain("phone-");
      expect(created.phoneNumberArn).toContain(":phone-number/");
      expect(created.phoneNumber).toMatch(/^\+1/);
      expect(created.numberType).toBe("SIMULATOR");
      expect(created.status === "ACTIVE" || created.status === "PENDING").toBe(
        true,
      );

      // Out-of-band verification via distilled.
      const observed = yield* getById(created.phoneNumberId);
      expect(observed?.PhoneNumberArn).toBe(created.phoneNumberArn);
      const tags = yield* smsvoice.listTagsForResource({
        ResourceArn: created.phoneNumberArn,
      });
      const tagRecord = Object.fromEntries(
        (tags.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecord.fixture).toBe("smsvoice-phone-number");
      expect(tagRecord["alchemy::id"]).toBe("TestNumber");

      // No-op redeploy keeps the same number.
      const noop = yield* stack.deploy(PhoneNumber("TestNumber", props));
      expect(noop.phoneNumberId).toBe(created.phoneNumberId);

      // Update in place — enable deletion protection; the ID must not
      // change.
      const updated = yield* stack.deploy(
        PhoneNumber("TestNumber", {
          ...props,
          deletionProtectionEnabled: true,
        }),
      );
      expect(updated.phoneNumberId).toBe(created.phoneNumberId);
      const reobserved = yield* getById(created.phoneNumberId);
      expect(reobserved?.DeletionProtectionEnabled).toBe(true);

      // Disable protection again so the release below succeeds.
      yield* stack.deploy(PhoneNumber("TestNumber", props));
      const unprotected = yield* getById(created.phoneNumberId);
      expect(unprotected?.DeletionProtectionEnabled).toBe(false);

      // Destroy and verify the release out-of-band.
      yield* stack.destroy();
      yield* assertPhoneNumberGone(created.phoneNumberId);
    }),
  { timeout: 240_000 },
);
