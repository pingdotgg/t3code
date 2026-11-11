import * as AWS from "@alchemy.run/aws";
import { AccountName } from "@alchemy.run/aws/Account";
import { describe, expect } from "@alchemy.run/test";
import * as account from "@distilled.cloud/aws/account";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as OrganizationLease from "../Organizations/OrganizationLease.ts";

// Shared organization lease: Floci reports the management account's name from
// the organization when one exists, so the organization must not be created or
// deleted while this test captures and restores the name.
const { test } = OrganizationLease.make({ providers: AWS.providers() }, "shared");

const unwrap = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : typeof value === "string" ? value : Redacted.value(value);

const TEST_NAME = "alchemy-test-account-name";

// getAccountInformation is eventually consistent after putAccountName (the
// rename can take ~20s to become visible), so out-of-band reads poll
// (bounded) until the expected name is observed.
const readNameUntil = (expected: string | undefined) =>
  account.getAccountInformation({}).pipe(
    Effect.map((info) => unwrap(info.AccountName)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (name): boolean => name === expected,
      times: 10,
    }),
  );

// The account name is an account-global singleton. This test captures the
// current name, renames the account to a marker, verifies out-of-band,
// destroys (a no-op — an account always has a name), and restores the
// original name so the account is left exactly as it was found.
describe.sequential(
  "Account AccountName",
  { tags: ["provider:aws", "provider:aws:account", "live"] },
  () => {
    test.provider(
      "set, read, and restore the account name",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const info = yield* account.getAccountInformation({});
          const originalName = unwrap(info.AccountName);

          const restore = Effect.gen(function* () {
            if (originalName !== undefined) {
              yield* account.putAccountName({ AccountName: originalName });
            }
          });

          yield* Effect.gen(function* () {
            const name = yield* stack.deploy(
              Effect.gen(function* () {
                return yield* AccountName("Name", {
                  accountName: TEST_NAME,
                });
              }),
            );

            expect(name.accountName).toBe(TEST_NAME);
            expect(name.accountId).toBe(info.AccountId);

            // Out-of-band verification (bounded poll through the rename's
            // eventual consistency).
            const live = yield* readNameUntil(TEST_NAME);
            expect(live).toBe(TEST_NAME);

            // Destroy is a no-op — an account always has a name, so the last
            // value stays in place.
            yield* stack.destroy();
            const after = yield* readNameUntil(TEST_NAME);
            expect(after).toBe(TEST_NAME);
          }).pipe(Effect.ensuring(restore.pipe(Effect.orDie)));

          // Confirm restoration matches the captured original.
          const restored = yield* readNameUntil(originalName);
          expect(restored).toBe(originalName);
        }),
      { timeout: 120_000 },
    );
  },
);
