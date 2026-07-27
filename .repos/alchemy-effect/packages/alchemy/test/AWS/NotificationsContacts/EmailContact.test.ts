import * as AWS from "@/AWS";
import { EmailContact } from "@/AWS/NotificationsContacts";
import * as Test from "@/Test/Alchemy";
import * as contacts from "@distilled.cloud/aws/notificationscontacts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const CONTACT_NAME = "alchemy-test-email-contact";
const EMAIL_A = "sam+alchemy-test-contact-a@alchemy.run";
const EMAIL_B = "sam+alchemy-test-contact-b@alchemy.run";

const unwrap = (value: string | Redacted.Redacted<string>): string =>
  typeof value === "string" ? value : Redacted.value(value);

const assertContactGone = (arn: string) =>
  contacts.getEmailContact({ arn }).pipe(
    Effect.flatMap(() => Effect.fail(new Error(`contact ${arn} still exists`))),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

describe("AWS.NotificationsContacts.EmailContact", () => {
  test.provider(
    "email contact lifecycle (unverified create, tag update, replacement)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployContact = (props: {
          emailAddress: string;
          tags: Record<string, string>;
        }) =>
          stack.deploy(
            Effect.gen(function* () {
              const contact = yield* EmailContact("OnCall", {
                name: CONTACT_NAME,
                emailAddress: props.emailAddress,
                tags: props.tags,
              });
              return {
                arn: contact.emailContactArn,
                name: contact.name,
                emailAddress: contact.emailAddress,
                status: contact.status,
              };
            }),
          );

        // CREATE — the contact exists in the unverified state (activation
        // is a human email-confirmation loop; AWS reports it as
        // `inactive` until the address owner confirms).
        const created = yield* deployContact({
          emailAddress: EMAIL_A,
          tags: { purpose: "alchemy-test" },
        });
        expect(created.arn).toContain(":emailcontact/");
        expect(created.name).toBe(CONTACT_NAME);
        expect(created.emailAddress).toBe(EMAIL_A);
        expect(created.status).toBe("inactive");

        // Out-of-band: the contact and its tags are live.
        const observed = yield* contacts.getEmailContact({
          arn: created.arn,
        });
        expect(unwrap(observed.emailContact.address)).toBe(EMAIL_A);
        expect(observed.emailContact.status).toBe("inactive");
        const tags = yield* contacts.listTagsForResource({
          arn: created.arn,
        });
        expect(tags.tags?.purpose).toBe("alchemy-test");
        expect(tags.tags?.["alchemy::id"]).toBe("OnCall");

        // UPDATE — tags are the only mutable aspect; the ARN is stable.
        const updated = yield* deployContact({
          emailAddress: EMAIL_A,
          tags: { purpose: "alchemy-test", updated: "true" },
        });
        expect(updated.arn).toBe(created.arn);
        const tagsAfterUpdate = yield* contacts.listTagsForResource({
          arn: created.arn,
        });
        expect(tagsAfterUpdate.tags?.updated).toBe("true");

        // REPLACE — contacts have no update API, so changing the address
        // replaces the contact (new ARN, old one deleted).
        const replaced = yield* deployContact({
          emailAddress: EMAIL_B,
          tags: { purpose: "alchemy-test" },
        });
        expect(replaced.arn).not.toBe(created.arn);
        expect(replaced.emailAddress).toBe(EMAIL_B);
        yield* assertContactGone(created.arn);

        // DESTROY — verified out-of-band with a typed wait-until-gone.
        yield* stack.destroy();
        yield* assertContactGone(replaced.arn);
      }),
    { timeout: 240_000 },
  );
});
