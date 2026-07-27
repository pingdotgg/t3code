import * as AWS from "@/AWS";
import { AlternateContact } from "@/AWS/Account";
import * as Test from "@/Test/Alchemy";
import * as account from "@distilled.cloud/aws/account";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

const unwrap = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

const CONTACT_TYPE = "OPERATIONS" as const;

const captureContact = () =>
  account.getAlternateContact({ AlternateContactType: CONTACT_TYPE }).pipe(
    Effect.map((r) => r.AlternateContact),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

// Account alternate contacts are account-global singletons — one per type. This
// test captures whatever OPERATIONS contact the account currently has, sets its
// own, verifies, tears down, and restores the original so the account is left
// exactly as it was found.
describe.sequential("Account AlternateContact", () => {
  test.provider(
    "set, read, and reset the OPERATIONS alternate contact",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const original = yield* captureContact();

        const restore = Effect.gen(function* () {
          if (original) {
            yield* account.putAlternateContact({
              AlternateContactType: CONTACT_TYPE,
              Name: unwrap(original.Name) ?? "",
              Title: unwrap(original.Title) ?? "",
              EmailAddress: unwrap(original.EmailAddress) ?? "",
              PhoneNumber: unwrap(original.PhoneNumber) ?? "",
            });
          } else {
            yield* account
              .deleteAlternateContact({ AlternateContactType: CONTACT_TYPE })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
          }
        });

        yield* Effect.gen(function* () {
          const contact = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* AlternateContact("OpsContact", {
                alternateContactType: CONTACT_TYPE,
                name: "Alchemy Test Ops",
                title: "On-Call",
                emailAddress: "alchemy-test-ops@example.com",
                phoneNumber: "+15555550100",
              });
            }),
          );

          expect(contact.alternateContactType).toBe(CONTACT_TYPE);
          expect(contact.emailAddress).toBe("alchemy-test-ops@example.com");

          // Out-of-band verification.
          const live = yield* captureContact();
          expect(unwrap(live?.EmailAddress)).toBe(
            "alchemy-test-ops@example.com",
          );
          expect(unwrap(live?.Name)).toBe("Alchemy Test Ops");

          // Destroy removes the contact.
          yield* stack.destroy();
          const gone = yield* captureContact();
          expect(gone).toBeUndefined();
        }).pipe(Effect.ensuring(restore.pipe(Effect.orDie)));

        // Confirm restoration matches the captured original.
        const restored = yield* captureContact();
        expect(unwrap(restored?.EmailAddress)).toBe(
          unwrap(original?.EmailAddress),
        );
      }),
    { timeout: 120_000 },
  );
});
