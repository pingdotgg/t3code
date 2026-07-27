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

// Gate on the dedicated env var so this test only runs in environments
// the operator has explicitly opted in to mutating the WARP default
// profile of.
const ENABLED = process.env.CLOUDFLARE_TEST_DEVICES === "1";
const skip = !ENABLED;

// Both cases mutate the same account-level WARP default device profile
// singleton; run them serially so they don't corrupt each other's captured
// baseline under the global concurrent test config.
describe.sequential("DefaultProfile", () => {
  test.provider.skipIf(skip)(
    "reads the existing default device profile without mutating it",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const before = yield* zeroTrust.getDevicePolicyDefault({ accountId });

        const profile = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Devices.DeviceDefaultProfile(
              "Default",
              {},
            );
          }),
        );

        expect(profile.accountId).toEqual(accountId);
        expect(["include", "exclude"]).toContain(profile.mode);

        // Nothing supplied => no PATCH, no PUTs => observed state matches before.
        const after = yield* zeroTrust.getDevicePolicyDefault({ accountId });
        expect(after.captivePortal ?? null).toEqual(
          before.captivePortal ?? null,
        );
        expect(after.allowedToLeave ?? null).toEqual(
          before.allowedToLeave ?? null,
        );

        // Singleton: delete is a no-op, so destroy must NOT remove the profile.
        yield* stack.destroy();
        const stillThere = yield* zeroTrust.getDevicePolicyDefault({
          accountId,
        });
        expect(stillThere).toBeDefined();
      }).pipe(logLevel),
  );

  test.provider.skipIf(skip)(
    "toggles captivePortal and restores the original value",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const original = yield* zeroTrust.getDevicePolicyDefault({ accountId });
        const originalCaptive = original.captivePortal ?? 180;

        // Step 1 — set to 180 seconds.
        const a = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Devices.DeviceDefaultProfile("Default", {
              captivePortal: 180,
            });
          }),
        );
        expect(a.captivePortal).toEqual(180);
        const live1 = yield* zeroTrust.getDevicePolicyDefault({ accountId });
        expect(live1.captivePortal).toEqual(180);

        // Step 2 — flip to 360.
        const b = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Devices.DeviceDefaultProfile("Default", {
              captivePortal: 360,
            });
          }),
        );
        expect(b.captivePortal).toEqual(360);
        const live2 = yield* zeroTrust.getDevicePolicyDefault({ accountId });
        expect(live2.captivePortal).toEqual(360);

        // Restore via a final deploy so the account is not left mutated.
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Devices.DeviceDefaultProfile("Default", {
              captivePortal: originalCaptive,
            });
          }),
        );

        yield* stack.destroy();
      }).pipe(logLevel),
  );

  // Canonical `list()` test (account-scoped singleton): there is exactly one
  // default device profile per account and no enumeration API, so `list()`
  // reads the single profile and returns it as a one-element array — exactly
  // mirroring `read`. Read-only, so it is NOT gated behind the mutation env
  // var; it only requires the account to have Zero Trust / WARP entitlement.
  test.provider("list returns the singleton default device profile", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Devices.DeviceDefaultProfile,
      );
      const all = yield* provider.list();

      // Account singleton: exactly one element, well-typed Attributes.
      expect(all.length).toEqual(1);
      expect(all[0].accountId).toEqual(accountId);
      expect(["include", "exclude"]).toContain(all[0].mode);

      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
