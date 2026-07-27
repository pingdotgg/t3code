import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const AUTH_DOMAIN = process.env.CLOUDFLARE_TEST_AUTH_DOMAIN;
const skip = !AUTH_DOMAIN;

// The Access organization is an account-wide singleton whose auth domain is
// allocated once and effectively immutable — the test adopts and mutates the
// LIVE org, so it only runs when the operator opts in by setting
// CLOUDFLARE_TEST_AUTH_DOMAIN to the account's <team>.cloudflareaccess.com domain.
// Both cases mutate the same account-wide Access organization singleton; run
// them serially so they don't corrupt each other under the global concurrent
// test config.
describe.sequential("Organization", () => {
  test.provider.skipIf(skip)(
    "adopts the existing Access organization",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const org = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain: AUTH_DOMAIN!,
              name: AUTH_DOMAIN!,
            });
          }),
        );

        expect(org.accountId).toEqual(accountId);
        expect(org.authDomain).toEqual(AUTH_DOMAIN);

        const live = yield* zeroTrust.listOrganizationsForAccount({
          accountId,
        });
        expect(live.authDomain).toEqual(AUTH_DOMAIN);

        // Singleton: delete is a no-op, so destroy must NOT remove the org.
        yield* stack.destroy();
        const stillThere = yield* zeroTrust.listOrganizationsForAccount({
          accountId,
        });
        expect(stillThere.authDomain).toEqual(AUTH_DOMAIN);
      }).pipe(logLevel),
  );

  // Same opt-in gate as above: toggling allow_authenticate_via_warp mutates the
  // account's live singleton org, so it requires CLOUDFLARE_TEST_AUTH_DOMAIN.
  test.provider.skipIf(skip)(
    "toggles allow_authenticate_via_warp and restores",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const original = yield* zeroTrust.listOrganizationsForAccount({
          accountId,
        });
        const originalWarp = original.allowAuthenticateViaWarp ?? false;
        const originalName = original.name ?? AUTH_DOMAIN!;

        // Step 1 — set to true.
        const enabled = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain: AUTH_DOMAIN!,
              name: originalName,
              allowAuthenticateViaWarp: true,
            });
          }),
        );
        expect(enabled.allowAuthenticateViaWarp).toEqual(true);
        const liveEnabled = yield* zeroTrust.listOrganizationsForAccount({
          accountId,
        });
        expect(liveEnabled.allowAuthenticateViaWarp).toEqual(true);

        // Step 2 — flip to false.
        const disabled = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain: AUTH_DOMAIN!,
              name: originalName,
              allowAuthenticateViaWarp: false,
            });
          }),
        );
        expect(disabled.allowAuthenticateViaWarp).toEqual(false);
        const liveDisabled = yield* zeroTrust.listOrganizationsForAccount({
          accountId,
        });
        expect(liveDisabled.allowAuthenticateViaWarp).toEqual(false);

        // Restore to original value via a final deploy so the account
        // isn't left mutated by the test.
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Organization("Org", {
              authDomain: AUTH_DOMAIN!,
              name: originalName,
              allowAuthenticateViaWarp: originalWarp,
            });
          }),
        );

        yield* stack.destroy();
      }).pipe(logLevel),
  );

  // Canonical `list()` test (account singleton): there is no enumeration API
  // for the Access organization, so `list()` reads the single account-wide
  // org via the same path `read` uses and returns the one-element array (or
  // `[]` when the account has never enabled Zero Trust). This is read-only —
  // it does not mutate the singleton — so it runs unconditionally.
  test.provider("list returns the account Access organization", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const provider = yield* Provider.findProvider(
        Cloudflare.Access.Organization,
      );
      const all = yield* provider.list();

      // Singleton: zero (Zero Trust never enabled) or exactly one.
      expect(all.length).toBeLessThanOrEqual(1);
      for (const org of all) {
        expect(org.accountId).toEqual(accountId);
        expect(typeof org.authDomain).toBe("string");
        expect(typeof org.name).toBe("string");
      }

      // `stack` is unused (no resource is deployed), but keep the destroy
      // bookend so the harness state stays clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
