import * as AWS from "@alchemy.run/aws";
import { AccountSettings } from "@alchemy.run/aws/SES";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getSuppressedReasons = sesv2
  .getAccount({})
  .pipe(Effect.map((response) => response.SuppressionAttributes?.SuppressedReasons ?? []));

// Account/region-global singleton: capture the live suppression configuration
// up front and restore it on scope close so the test leaves the account exactly
// as it found it, even if an assertion fails mid-way. Deleting the resource is
// a no-op (it leaves settings in place), so the restore MUST be explicit.
// The "aws:ses-account" label keeps other SES account-singleton tests out.
test.provider(
  "manages the account suppression list in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const originalReasons = yield* getSuppressedReasons;
      yield* Effect.addFinalizer(() =>
        sesv2
          .putAccountSuppressionAttributes({
            SuppressedReasons: originalReasons,
          })
          .pipe(Effect.ignore),
      );

      // Create — converge the account suppression list onto both reasons.
      const created = yield* stack.deploy(
        AccountSettings("Account", {
          suppression: { reasons: ["BOUNCE", "COMPLAINT"] },
        }),
      );
      expect([...created.suppressedReasons].sort()).toEqual(["BOUNCE", "COMPLAINT"]);
      expect([...(yield* getSuppressedReasons)].sort()).toEqual(["BOUNCE", "COMPLAINT"]);

      // Update in place — narrow the suppression list to a single reason.
      const updated = yield* stack.deploy(
        AccountSettings("Account", {
          suppression: { reasons: ["BOUNCE"] },
        }),
      );
      expect(updated.suppressedReasons).toEqual(["BOUNCE"]);
      expect(yield* getSuppressedReasons).toEqual(["BOUNCE"]);

      // Destroy is a no-op: the account settings remain as last configured
      // until the finalizer restores the captured original.
      yield* stack.destroy();
      expect(yield* getSuppressedReasons).toEqual(["BOUNCE"]);
    }),
  {
    tags: ["provider:aws", "provider:aws:ses", "live"],
    timeout: 120_000,
    exclusive: "aws:ses-account",
  },
);

const getSendingEnabled = sesv2
  .getAccount({})
  .pipe(Effect.map((response) => response.SendingEnabled ?? false));

const restoreSendingEnabled = (enabled: boolean) =>
  sesv2.putAccountSendingAttributes({ SendingEnabled: enabled }).pipe(Effect.ignore);

// Toggling `sendingEnabled` pauses ALL sending for the account in the run's
// region. It cannot be isolated to a throwaway region: `AWS.providers()`
// merges `Region.fromEnvironment` into the provider layer itself, so a
// `Region` provided around the test body never reaches the provider's SDK
// calls. Containment is therefore the `aws:ses-account` label, which every
// test that sends through SES holds too, plus a finalizer that restores the
// captured value on failure and interruption as well as success. A whole-run
// `exclusive: true` would instead stall every other test behind the slowest
// one in flight (MWAA, ElastiCache: 20+ minutes).
test.provider(
  "toggles account-level sending in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const original = yield* getSendingEnabled;
      yield* Effect.addFinalizer(() => restoreSendingEnabled(original));

      // Sending starts enabled; converge it to disabled.
      const disabled = yield* stack.deploy(AccountSettings("Account", { sendingEnabled: false }));
      expect(disabled.sendingEnabled).toBe(false);
      expect(yield* getSendingEnabled).toBe(false);

      // Re-enable in place — the same reconciler converges either direction.
      const enabled = yield* stack.deploy(AccountSettings("Account", { sendingEnabled: true }));
      expect(enabled.sendingEnabled).toBe(true);
      expect(yield* getSendingEnabled).toBe(true);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:ses", "live"],
    timeout: 120_000,
    exclusive: "aws:ses-account",
  },
);
