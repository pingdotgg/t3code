import * as AWS from "@/AWS";
import { ContactList } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// SES allows only one contact list per AWS account, so every test that creates
// one is `exclusive` — two contact-list suites running concurrently would
// collide on the account-wide singleton.

class ContactListStillExists extends Data.TaggedError(
  "ContactListStillExists",
)<{
  readonly name: string;
}> {}

const assertContactListDeleted = (name: string) =>
  sesv2.getContactList({ ContactListName: name }).pipe(
    Effect.flatMap(() => Effect.fail(new ContactListStillExists({ name }))),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ContactListStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "contact list lifecycle: create, update topics/description/tags, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const list = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ContactList("Newsletter", {
            description: "Weekly newsletter",
            topics: [
              {
                TopicName: "product-updates",
                DisplayName: "Product Updates",
                DefaultSubscriptionStatus: "OPT_IN",
              },
            ],
            tags: { Environment: "test" },
          });
        }),
      );

      expect(list.contactListName).toBeDefined();
      expect(list.contactListArn).toContain(":contact-list/");

      // out-of-band verification via distilled
      const observed = yield* sesv2.getContactList({
        ContactListName: list.contactListName,
      });
      expect(observed.Description).toBe("Weekly newsletter");
      expect(observed.Topics?.[0]?.TopicName).toBe("product-updates");
      const tags = Object.fromEntries(
        (observed.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("Newsletter");

      // update description, add a topic, add a tag
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ContactList("Newsletter", {
            description: "Weekly product newsletter",
            topics: [
              {
                TopicName: "product-updates",
                DisplayName: "Product Updates",
                DefaultSubscriptionStatus: "OPT_IN",
              },
              {
                TopicName: "promotions",
                DisplayName: "Promotions",
                DefaultSubscriptionStatus: "OPT_OUT",
              },
            ],
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      const updated = yield* sesv2.getContactList({
        ContactListName: list.contactListName,
      });
      expect(updated.Description).toBe("Weekly product newsletter");
      expect((updated.Topics ?? []).length).toBe(2);
      const updatedTags = Object.fromEntries(
        (updated.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(updatedTags.Extra).toBe("1");

      yield* stack.destroy();
      yield* assertContactListDeleted(list.contactListName);
    }),
  { timeout: 120_000, exclusive: true },
);

test.provider(
  "custom name replaces on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ContactList("Named", {
            contactListName: "alchemy-test-contact-list-a",
          });
        }),
      );
      expect(first.contactListName).toBe("alchemy-test-contact-list-a");

      // The rename replaces delete-first: creating -b before deleting -a would
      // exceed the one-contact-list-per-account limit.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ContactList("Named", {
            contactListName: "alchemy-test-contact-list-b",
          });
        }),
      );
      expect(second.contactListName).toBe("alchemy-test-contact-list-b");
      yield* assertContactListDeleted("alchemy-test-contact-list-a");

      yield* stack.destroy();
      yield* assertContactListDeleted("alchemy-test-contact-list-b");
    }),
  { timeout: 120_000, exclusive: true },
);
