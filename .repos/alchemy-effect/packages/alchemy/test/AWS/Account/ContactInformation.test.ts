import * as AWS from "@/AWS";
import { ContactInformation } from "@/AWS/Account";
import * as Test from "@/Test/Alchemy";
import * as account from "@distilled.cloud/aws/account";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const unwrap = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

const captureContact = () =>
  account.getContactInformation({}).pipe(
    Effect.map((r) => r.ContactInformation),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

// getContactInformation is eventually consistent after putContactInformation,
// so out-of-band reads poll (bounded) until the expected company name shows.
const captureContactUntil = (expectedCompany: string | undefined) =>
  captureContact().pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (contact): boolean =>
        unwrap(contact?.CompanyName) === expectedCompany,
      times: 10,
    }),
  );

// AWS validates the phone number for pattern validity (e.g. NANP numbers
// with an invalid area code like 555, or an exchange starting with 1, are
// rejected with `ValidationException: The specified PhoneNumber is not
// valid`). Reuse the account's current primary-contact phone when one exists
// — it is guaranteed to pass — and fall back to a pattern-valid number.
const FALLBACK_PHONE = "+12025550100";

// The primary contact is an account-global singleton that cannot be deleted.
// This test captures whatever primary contact the account currently has, sets
// its own, updates it, and restores the original in `ensuring` so the account
// is left exactly as it was found.
describe.sequential("Account ContactInformation", () => {
  test.provider(
    "set, update, and restore the primary contact",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const original = yield* captureContact();
        const testPhone = unwrap(original?.PhoneNumber) ?? FALLBACK_PHONE;

        const restore = Effect.gen(function* () {
          if (original) {
            yield* account.putContactInformation({
              ContactInformation: original,
            });
          }
        });

        yield* Effect.gen(function* () {
          const deployContact = (companyName: string) =>
            stack.deploy(
              Effect.gen(function* () {
                return yield* ContactInformation("PrimaryContact", {
                  fullName: "Alchemy Test",
                  addressLine1: "123 Any Street",
                  city: "Seattle",
                  stateOrRegion: "WA",
                  postalCode: "98101",
                  countryCode: "US",
                  phoneNumber: testPhone,
                  companyName,
                });
              }),
            );

          const contact = yield* deployContact("Alchemy");
          expect(contact.fullName).toBe("Alchemy Test");
          expect(contact.companyName).toBe("Alchemy");

          // Out-of-band verification (bounded poll through put→get eventual
          // consistency).
          const live = yield* captureContactUntil("Alchemy");
          expect(unwrap(live?.FullName)).toBe("Alchemy Test");
          expect(unwrap(live?.CompanyName)).toBe("Alchemy");

          // Update: the singleton is upserted in place.
          const updated = yield* deployContact("Alchemy Updated");
          expect(updated.companyName).toBe("Alchemy Updated");
          const liveUpdated = yield* captureContactUntil("Alchemy Updated");
          expect(unwrap(liveUpdated?.CompanyName)).toBe("Alchemy Updated");

          // Destroy is a no-op — AWS does not allow deleting the primary
          // contact, so the last value stays in place.
          yield* stack.destroy();
          const after = yield* captureContactUntil("Alchemy Updated");
          expect(unwrap(after?.FullName)).toBe("Alchemy Test");
        }).pipe(Effect.ensuring(restore.pipe(Effect.orDie)));

        // Confirm restoration matches the captured original (bounded poll
        // through put→get eventual consistency).
        const restored = yield* captureContact().pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (contact): boolean =>
              unwrap(contact?.FullName) === unwrap(original?.FullName),
            times: 10,
          }),
        );
        expect(unwrap(restored?.FullName)).toBe(unwrap(original?.FullName));
      }),
    { timeout: 120_000 },
  );
});
