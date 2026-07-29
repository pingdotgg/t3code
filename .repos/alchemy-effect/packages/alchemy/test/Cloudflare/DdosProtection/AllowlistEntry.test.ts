import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ddos from "@distilled.cloud/cloudflare/ddos-protection";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Advanced TCP Protection is a Magic Transit (Enterprise add-on)
// entitlement. The testing account does not have it, so the full lifecycle
// suite is gated behind an opt-in env var; the ungated test asserts the
// typed `AdvancedTcpProtectionNotEntitled` error (Cloudflare code 8888)
// surfaces on accounts without the entitlement.
const magicTransit = process.env.CLOUDFLARE_TEST_MAGIC_TRANSIT;

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const accountId = Effect.gen(function* () {
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  return accountId;
});

// Inverse probe: pins the typed `AdvancedTcpProtectionNotEntitled` rejection,
// so it skips on entitled accounts (CLOUDFLARE_TEST_MAGIC_TRANSIT set), where
// the API would accept the call.
test.provider.skipIf(!!magicTransit)(
  "surfaces the typed AdvancedTcpProtectionNotEntitled error without Magic Transit",
  (stack) =>
    Effect.gen(function* () {
      const acct = yield* accountId;

      yield* stack.destroy();

      const error = yield* ddos
        .createAdvancedTcpProtectionAllowlist({
          accountId: acct,
          prefix: "192.0.2.0/24",
          comment: "alchemy-ddos-entitlement-probe",
          enabled: false,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("AdvancedTcpProtectionNotEntitled");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!magicTransit)(
  "creates an allowlist entry, updates it in place, replaces on prefix change, and destroys",
  (stack) =>
    Effect.gen(function* () {
      const acct = yield* accountId;

      yield* stack.destroy();

      // Create.
      const entry = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DdosProtection.DdosAllowlistEntry("Entry", {
            prefix: "192.0.2.0/24",
            comment: "alchemy ddos allowlist test",
            enabled: false,
          });
        }),
      );
      expect(entry.prefix).toEqual("192.0.2.0/24");
      expect(entry.enabled).toBe(false);

      // Out-of-band verification via the distilled API.
      const live = yield* ddos.getAdvancedTcpProtectionAllowlistItem({
        accountId: acct,
        prefixId: entry.allowlistId,
      });
      expect(live.prefix).toEqual("192.0.2.0/24");
      expect(live.enabled).toBe(false);

      // In-place update — comment and enabled are patched, id is stable.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DdosProtection.DdosAllowlistEntry("Entry", {
            prefix: "192.0.2.0/24",
            comment: "alchemy ddos allowlist test (updated)",
            enabled: true,
          });
        }),
      );
      expect(updated.allowlistId).toEqual(entry.allowlistId);
      expect(updated.enabled).toBe(true);
      expect(updated.comment).toEqual("alchemy ddos allowlist test (updated)");

      // Replacement — the prefix is the entry's identity.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DdosProtection.DdosAllowlistEntry("Entry", {
            prefix: "198.51.100.0/24",
            comment: "alchemy ddos allowlist test (replaced)",
            enabled: true,
          });
        }),
      );
      expect(replaced.allowlistId).not.toEqual(entry.allowlistId);
      expect(replaced.prefix).toEqual("198.51.100.0/24");

      yield* stack.destroy();

      // Gone — the typed AllowlistEntryNotFound error proves deletion.
      const error = yield* ddos
        .getAdvancedTcpProtectionAllowlistItem({
          accountId: acct,
          prefixId: replaced.allowlistId,
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("AllowlistEntryNotFound");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Account-scoped collection `list()` (pattern (b)): enumerate every allowlist
// entry under the ambient account. On accounts without the Magic Transit /
// Advanced TCP Protection entitlement the enumeration API rejects with the
// typed `AdvancedTcpProtectionNotEntitled` error (Cloudflare code 8888), which
// `list()` maps to a well-typed empty array — assert that here, ungated.
test.provider(
  "list returns a well-typed empty array without Magic Transit",
  (stack) =>
    Effect.gen(function* () {
      if (magicTransit) return;

      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.DdosProtection.DdosAllowlistEntry,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      expect(all).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Entitled accounts (CLOUDFLARE_TEST_MAGIC_TRANSIT set): deploy an entry and
// assert it appears in the exhaustively-paginated `list()` result.
test.provider.skipIf(!magicTransit)(
  "list enumerates the deployed allowlist entry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DdosProtection.DdosAllowlistEntry(
            "ListEntry",
            {
              prefix: "203.0.113.0/24",
              comment: "alchemy ddos allowlist list test",
              enabled: false,
            },
          );
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.DdosProtection.DdosAllowlistEntry,
      );
      const all = yield* provider.list();

      expect(all.some((x) => x.allowlistId === deployed.allowlistId)).toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
