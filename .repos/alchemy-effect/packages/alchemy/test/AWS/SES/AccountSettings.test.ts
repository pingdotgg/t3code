import * as AWS from "@/AWS";
import { AccountSettings } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getSuppressedReasons = sesv2
  .getAccount({})
  .pipe(
    Effect.map(
      (response) => response.SuppressionAttributes?.SuppressedReasons ?? [],
    ),
  );

// Account/region-global singleton: capture the live suppression configuration
// up front and restore it on scope close so the test leaves the account exactly
// as it found it, even if an assertion fails mid-way. Deleting the resource is
// a no-op (it leaves settings in place), so the restore MUST be explicit.
// `exclusive` because this mutates process-global account state.
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
      expect([...created.suppressedReasons].sort()).toEqual([
        "BOUNCE",
        "COMPLAINT",
      ]);
      expect([...(yield* getSuppressedReasons)].sort()).toEqual([
        "BOUNCE",
        "COMPLAINT",
      ]);

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
  { timeout: 120_000, exclusive: true },
);

const getSendingEnabled = sesv2
  .getAccount({})
  .pipe(Effect.map((response) => response.SendingEnabled ?? false));

const restoreSendingEnabled = (enabled: boolean) =>
  sesv2
    .putAccountSendingAttributes({ SendingEnabled: enabled })
    .pipe(Effect.ignore);

// Toggling `sendingEnabled` pauses ALL sending for the account in the run's
// region. It cannot be isolated to a throwaway region: `AWS.providers()`
// merges `Region.fromEnvironment` into the provider layer itself, so a
// `Region` provided around the test body never reaches the provider's SDK
// calls. Containment is therefore `exclusive` (no other test runs in-process
// while this one holds the lock) plus a finalizer that restores the captured
// value on failure and interruption as well as success.
test.provider(
  "toggles account-level sending in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const original = yield* getSendingEnabled;
      yield* Effect.addFinalizer(() => restoreSendingEnabled(original));

      // Sending starts enabled; converge it to disabled.
      const disabled = yield* stack.deploy(
        AccountSettings("Account", { sendingEnabled: false }),
      );
      expect(disabled.sendingEnabled).toBe(false);
      expect(yield* getSendingEnabled).toBe(false);

      // Re-enable in place — the same reconciler converges either direction.
      const enabled = yield* stack.deploy(
        AccountSettings("Account", { sendingEnabled: true }),
      );
      expect(enabled.sendingEnabled).toBe(true);
      expect(yield* getSendingEnabled).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 120_000, exclusive: true },
);
