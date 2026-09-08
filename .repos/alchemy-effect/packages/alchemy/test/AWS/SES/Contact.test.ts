import * as AWS from "@/AWS";
import { Contact, ContactList } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class ContactStillExists extends Data.TaggedError("ContactStillExists")<{
  readonly contactListName: string;
  readonly emailAddress: string;
}> {}

const assertContactDeleted = (contactListName: string, emailAddress: string) =>
  sesv2
    .getContact({
      ContactListName: contactListName,
      EmailAddress: emailAddress,
    })
    .pipe(
      Effect.flatMap(() =>
        Effect.fail(new ContactStillExists({ contactListName, emailAddress })),
      ),
      // A deleted contact list takes its contacts with it.
      Effect.catchTag("NotFoundException", () => Effect.void),
      Effect.retry({
        while: (e) => e._tag === "ContactStillExists",
        schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
      }),
    );

test.provider(
  "contact lifecycle: create with preferences, update, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { list, contact } = yield* stack.deploy(
        Effect.gen(function* () {
          const list = yield* ContactList("ContactHostList", {
            topics: [
              {
                TopicName: "product-updates",
                DisplayName: "Product Updates",
                DefaultSubscriptionStatus: "OPT_OUT",
              },
            ],
          });
          const contact = yield* Contact("Subscriber", {
            contactListName: list.contactListName,
            emailAddress: "reader@alchemy-test.example.com",
            topicPreferences: [
              { TopicName: "product-updates", SubscriptionStatus: "OPT_IN" },
            ],
            attributes: { plan: "free" },
          });
          return { list, contact };
        }),
      );

      expect(contact.contactListName).toBe(list.contactListName);
      expect(contact.emailAddress).toBe("reader@alchemy-test.example.com");

      // out-of-band verification via distilled
      const observed = yield* sesv2.getContact({
        ContactListName: list.contactListName,
        EmailAddress: "reader@alchemy-test.example.com",
      });
      expect(observed.TopicPreferences?.[0]?.SubscriptionStatus).toBe("OPT_IN");
      expect(observed.AttributesData).toContain("free");

      // update preferences and unsubscribe-all in place
      yield* stack.deploy(
        Effect.gen(function* () {
          const list = yield* ContactList("ContactHostList", {
            topics: [
              {
                TopicName: "product-updates",
                DisplayName: "Product Updates",
                DefaultSubscriptionStatus: "OPT_OUT",
              },
            ],
          });
          yield* Contact("Subscriber", {
            contactListName: list.contactListName,
            emailAddress: "reader@alchemy-test.example.com",
            topicPreferences: [
              { TopicName: "product-updates", SubscriptionStatus: "OPT_OUT" },
            ],
            unsubscribeAll: true,
          });
        }),
      );
      const updated = yield* sesv2.getContact({
        ContactListName: list.contactListName,
        EmailAddress: "reader@alchemy-test.example.com",
      });
      expect(updated.UnsubscribeAll).toBe(true);

      yield* stack.destroy();
      yield* assertContactDeleted(
        list.contactListName,
        "reader@alchemy-test.example.com",
      );
    }),
  { timeout: 120_000, exclusive: true },
);

test.provider(
  "changing the email address replaces the contact within the same list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The list stays deployed across the replacement so the engine never
      // removes a dependency of the resource being replaced.
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const list = yield* ContactList("EmailChangeList", {});
          const contact = yield* Contact("Subscriber", {
            contactListName: list.contactListName,
            emailAddress: "first@alchemy-test.example.com",
          });
          return {
            contactListName: list.contactListName,
            emailAddress: contact.emailAddress,
          };
        }),
      );
      expect(first.emailAddress).toBe("first@alchemy-test.example.com");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const list = yield* ContactList("EmailChangeList", {});
          const contact = yield* Contact("Subscriber", {
            contactListName: list.contactListName,
            emailAddress: "second@alchemy-test.example.com",
          });
          return {
            contactListName: list.contactListName,
            emailAddress: contact.emailAddress,
          };
        }),
      );
      expect(second.emailAddress).toBe("second@alchemy-test.example.com");
      yield* assertContactDeleted(
        first.contactListName,
        "first@alchemy-test.example.com",
      );

      yield* stack.destroy();
      yield* assertContactDeleted(
        second.contactListName,
        "second@alchemy-test.example.com",
      );
    }),
  { timeout: 120_000, exclusive: true },
);
