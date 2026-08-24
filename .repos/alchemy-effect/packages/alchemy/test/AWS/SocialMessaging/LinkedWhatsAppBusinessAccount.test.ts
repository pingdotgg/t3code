import * as AWS from "@/AWS";
import { LinkedWhatsAppBusinessAccount } from "@/AWS/SocialMessaging";
import * as Test from "@/Test/Alchemy";
import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// WhatsApp Business onboarding requires the Meta embedded-signup OAuth flow
// in the AWS console (cannot be automated), so the full lifecycle is gated
// behind AWS_TEST_SOCIALMESSAGING=1 + AWS_TEST_SOCIALMESSAGING_WABA_ID.
// The ungated probes below prove the distilled error union carries the typed
// tags the provider's read/reconcile/delete paths depend on, in every CI run.

test.provider(
  "listLinkedWhatsAppBusinessAccounts succeeds (no onboarding required)",
  () =>
    Effect.gen(function* () {
      const response =
        yield* socialmessaging.listLinkedWhatsAppBusinessAccounts({});
      expect(Array.isArray(response.linkedAccounts ?? [])).toBe(true);
    }),
);

test.provider(
  "getLinkedWhatsAppBusinessAccount on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        socialmessaging.getLinkedWhatsAppBusinessAccount({
          // well-formed but nonexistent linked-WABA id
          id: "waba-0123456789abcdef0123456789abcdef",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "disassociateWhatsAppBusinessAccount on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        socialmessaging.disassociateWhatsAppBusinessAccount({
          id: "waba-0123456789abcdef0123456789abcdef",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Full lifecycle — requires a WhatsApp Business Account already linked via
// the AWS End User Messaging Social console (Meta embedded signup). Set
// AWS_TEST_SOCIALMESSAGING=1 and AWS_TEST_SOCIALMESSAGING_WABA_ID=waba-...
// to run. NOTE: the final stack.destroy() disassociates the WABA from the
// AWS account; re-running afterwards requires redoing the console signup.
test.provider.skipIf(
  !process.env.AWS_TEST_SOCIALMESSAGING ||
    !process.env.AWS_TEST_SOCIALMESSAGING_WABA_ID,
)(
  "adopt linked WABA, sync tags + event destinations, destroy",
  (stack) =>
    Effect.gen(function* () {
      const wabaId = process.env.AWS_TEST_SOCIALMESSAGING_WABA_ID!;
      yield* stack.destroy();

      const { account } = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* LinkedWhatsAppBusinessAccount("Business", {
            accountId: wabaId,
            tags: { fixture: "socialmessaging" },
          });
          return { account };
        }),
      );

      expect(account.id).toBe(wabaId);
      expect(account.arn).toContain(":waba/");
      expect(account.wabaId).toBeDefined();
      expect(account.wabaName).toBeDefined();
      expect(account.tags.fixture).toBe("socialmessaging");

      // Out-of-band verification via distilled.
      const observed = yield* socialmessaging.getLinkedWhatsAppBusinessAccount({
        id: wabaId,
      });
      expect(observed.account?.id).toBe(wabaId);
      const observedTags = yield* socialmessaging.listTagsForResource({
        resourceArn: account.arn,
      });
      const tagMap = Object.fromEntries(
        (observedTags.tags ?? []).map((tag) => [tag.key, tag.value]),
      );
      expect(tagMap.fixture).toBe("socialmessaging");
      expect(tagMap["alchemy::id"]).toBe("Business");

      // Update — change tags only.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* LinkedWhatsAppBusinessAccount("Business", {
            accountId: wabaId,
            tags: { fixture: "socialmessaging", updated: "true" },
          });
          return { account };
        }),
      );
      expect(updated.account.tags.updated).toBe("true");

      // Destroy — disassociates the WABA; verify it is gone.
      yield* stack.destroy();
      const gone = yield* Effect.flip(
        socialmessaging.getLinkedWhatsAppBusinessAccount({ id: wabaId }),
      );
      expect(gone._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 120_000 },
);
