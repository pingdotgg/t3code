import * as AWS from "@/AWS";
import { ConfigurationSet, EmailIdentity } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic identity names — never verified, creation alone is the test.
const TEST_DOMAIN = "ses-identity.alchemy-test.example.com";
const TEST_DOMAIN_B = "ses-identity-b.alchemy-test.example.com";
const TEST_EMAIL = "alchemy-ses-test@example.com";

class IdentityStillExists extends Data.TaggedError("IdentityStillExists")<{
  readonly name: string;
}> {}

const assertIdentityDeleted = (name: string) =>
  sesv2.getEmailIdentity({ EmailIdentity: name }).pipe(
    Effect.flatMap(() => Effect.fail(new IdentityStillExists({ name }))),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "IdentityStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "domain identity lifecycle: DKIM tokens, tags, replacement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const identity = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EmailIdentity("DomainIdentity", {
            emailIdentity: TEST_DOMAIN,
            tags: { Environment: "test" },
          });
        }),
      );

      expect(identity.emailIdentity).toBe(TEST_DOMAIN);
      expect(identity.identityArn).toContain(`:identity/${TEST_DOMAIN}`);
      expect(identity.identityType).toBe("DOMAIN");
      // sandbox: DKIM tokens are returned immediately, verification stays
      // pending — never block on VerificationStatus=SUCCESS.
      expect(identity.dkimTokens).toHaveLength(3);
      expect(identity.verifiedForSendingStatus).toBe(false);

      // out-of-band verification via distilled
      const observed = yield* sesv2.getEmailIdentity({
        EmailIdentity: TEST_DOMAIN,
      });
      expect(observed.IdentityType).toBe("DOMAIN");
      const tags = Object.fromEntries(
        (observed.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("DomainIdentity");

      // update tags in place
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EmailIdentity("DomainIdentity", {
            emailIdentity: TEST_DOMAIN,
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      const afterTagUpdate = yield* sesv2.getEmailIdentity({
        EmailIdentity: TEST_DOMAIN,
      });
      const updatedTags = Object.fromEntries(
        (afterTagUpdate.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(updatedTags.Extra).toBe("1");

      // changing the identity replaces it
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EmailIdentity("DomainIdentity", {
            emailIdentity: TEST_DOMAIN_B,
            tags: { Environment: "test" },
          });
        }),
      );
      expect(replaced.emailIdentity).toBe(TEST_DOMAIN_B);
      yield* assertIdentityDeleted(TEST_DOMAIN);

      yield* stack.destroy();
      yield* assertIdentityDeleted(TEST_DOMAIN_B);
    }),
  { timeout: 120_000 },
);

test.provider(
  "email-address identity is created pending verification",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const identity = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EmailIdentity("AddressIdentity", {
            emailIdentity: TEST_EMAIL,
          });
        }),
      );

      expect(identity.identityType).toBe("EMAIL_ADDRESS");
      // sandbox: verification email goes out; the identity exists but is
      // not verified for sending — assert pending, never wait for SUCCESS.
      expect(identity.verifiedForSendingStatus).toBe(false);

      yield* stack.destroy();
      yield* assertIdentityDeleted(TEST_EMAIL);
    }),
  { timeout: 120_000 },
);

test.provider(
  "identity with configuration-set association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { identity, configSet } = yield* stack.deploy(
        Effect.gen(function* () {
          const configSet = yield* ConfigurationSet("IdentityConfigSet", {});
          const identity = yield* EmailIdentity("AssociatedIdentity", {
            emailIdentity: "ses-assoc.alchemy-test.example.com",
            configurationSetName: configSet.configurationSetName,
          });
          return { identity, configSet };
        }),
      );

      const observed = yield* sesv2.getEmailIdentity({
        EmailIdentity: identity.emailIdentity,
      });
      expect(observed.ConfigurationSetName).toBe(
        configSet.configurationSetName,
      );

      // remove the association in place (keep the config set deployed so
      // the update never races a dependency removal)
      yield* stack.deploy(
        Effect.gen(function* () {
          const configSet = yield* ConfigurationSet("IdentityConfigSet", {});
          const identity = yield* EmailIdentity("AssociatedIdentity", {
            emailIdentity: "ses-assoc.alchemy-test.example.com",
          });
          return { identity, configSet };
        }),
      );
      const afterRemoval = yield* sesv2.getEmailIdentity({
        EmailIdentity: identity.emailIdentity,
      });
      expect(afterRemoval.ConfigurationSetName).toBeUndefined();

      yield* stack.destroy();
      yield* assertIdentityDeleted(identity.emailIdentity);
    }),
  { timeout: 120_000 },
);
