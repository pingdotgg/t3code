import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getSettings = (accountId: string) =>
  zeroTrust.getDeviceSetting({ accountId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

test.provider(
  "patches disableForTime and restores the original value on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Capture the live singleton before Alchemy manages it; the
      // capture-and-restore contract must put it back on destroy.
      const before = yield* getSettings(accountId);
      const beforeDisable = before.disableForTime ?? null;

      // Step 1 — set the WARP override-code time limit. `disableForTime`
      // is the lowest-risk field on the singleton: it only affects how
      // long manually-issued override codes last.
      const a = yield* stack.deploy(
        Cloudflare.Devices.DeviceSettings("Devices", { disableForTime: 3600 }),
      );
      expect(a.accountId).toEqual(accountId);
      expect(a.disableForTime).toEqual(3600);
      expect(a.initialSettings.disableForTime ?? null).toEqual(beforeDisable);

      const live1 = yield* getSettings(accountId);
      expect(live1.disableForTime).toEqual(3600);

      // Step 2 — update in place; the initial snapshot must be preserved,
      // not re-captured from the now-managed state.
      const b = yield* stack.deploy(
        Cloudflare.Devices.DeviceSettings("Devices", { disableForTime: 7200 }),
      );
      expect(b.disableForTime).toEqual(7200);
      expect(b.initialSettings.disableForTime ?? null).toEqual(beforeDisable);

      const live2 = yield* getSettings(accountId);
      expect(live2.disableForTime).toEqual(7200);

      // Step 3 — a no-op redeploy must not lose the snapshot either.
      const c = yield* stack.deploy(
        Cloudflare.Devices.DeviceSettings("Devices", { disableForTime: 7200 }),
      );
      expect(c.disableForTime).toEqual(7200);
      expect(c.initialSettings.disableForTime ?? null).toEqual(beforeDisable);

      // Destroy — the singleton must be restored to its pre-managed state.
      yield* stack.destroy();
      const after = yield* getSettings(accountId);
      expect(after.disableForTime ?? null).toEqual(beforeDisable);
    }).pipe(logLevel),
);

// Canonical `list()` test (account-scoped singleton): there is exactly one
// device-settings object per account and no enumeration API, so `list()`
// reads the single singleton and returns a one-element Attributes array.
test.provider("list returns the account's device settings singleton", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const provider = yield* Provider.findProvider(
      Cloudflare.Devices.DeviceSettings,
    );
    const all = yield* provider.list();

    // Exactly one element — the account-wide singleton — well-typed as
    // DeviceSettings["Attributes"].
    expect(all.length).toEqual(1);
    expect(all[0].accountId).toEqual(accountId);
    expect(all[0].initialSettings).toBeDefined();

    yield* stack.destroy();
  }).pipe(logLevel),
);
