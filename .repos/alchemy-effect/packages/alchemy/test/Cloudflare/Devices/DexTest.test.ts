import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// DEX synthetic tests require the Digital Experience Monitoring
// entitlement. On the standard testing account
// `POST /accounts/{id}/dex/devices/dex_tests` fails with HTTP 403 code
// 11007 "dex.api.entitlements.missing" — surfaced as the typed
// `Forbidden` error. The lifecycle test is gated behind an entitled
// account supplied via env; the probe test always runs and pins the
// typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_DEX;

const TEST_NAME = "alchemy-test-dex";

test.provider.skipIf(entitled)(
  "unentitled accounts surface the typed Forbidden entitlement error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const error = yield* zeroTrust
        .createDeviceDexTest({
          accountId,
          name: "alchemy-dex-entitlement-probe",
          enabled: true,
          interval: "0h30m0s",
          data: { host: "https://example.com", kind: "http", method: "GET" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("Forbidden");
      if (error._tag === "Forbidden") {
        expect(error.message).toContain("dex.api.entitlements.missing");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!entitled)(
  "create, update in place, and destroy a DEX test",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Devices.DeviceDexTest("AppHealth", {
            name: TEST_NAME,
            data: {
              host: "https://app.example.com/health",
              kind: "http",
              method: "GET",
            },
            interval: "0h30m0s",
            description: "v1",
          });
        }),
      );

      expect(created.testId).toBeDefined();
      expect(created.accountId).toEqual(accountId);
      expect(created.name).toEqual(TEST_NAME);
      expect(created.interval).toEqual("0h30m0s");
      expect(created.enabled).toEqual(true);

      const live = yield* zeroTrust.getDeviceDexTest({
        accountId,
        dexTestId: created.testId,
      });
      expect(live.name).toEqual(TEST_NAME);

      // Interval + description update converges in place — same test id.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Devices.DeviceDexTest("AppHealth", {
            name: TEST_NAME,
            data: {
              host: "https://app.example.com/health",
              kind: "http",
              method: "GET",
            },
            interval: "1h0m0s",
            description: "v2",
            enabled: false,
          });
        }),
      );
      expect(updated.testId).toEqual(created.testId);
      expect(updated.interval).toEqual("1h0m0s");
      expect(updated.description).toEqual("v2");
      expect(updated.enabled).toEqual(false);

      yield* stack.destroy();

      const gone = yield* zeroTrust
        .getDeviceDexTest({ accountId, dexTestId: created.testId })
        .pipe(Effect.flip);
      expect(gone._tag).toEqual("DexTestNotFound");
    }).pipe(logLevel),
  { timeout: 90_000 },
);

// Canonical `list()` test (account-scoped collection). The lifecycle requires
// the DEX entitlement, so the deploy + presence assertion is gated behind an
// entitled account. On unentitled accounts the provider's `list()` catches the
// typed `Forbidden` (dex.api.entitlements.missing) and returns `[]`; the ungated
// half of this test asserts that well-typed empty result so a clean skip run
// still exercises `list()`.
test.provider.skipIf(!entitled)(
  "list enumerates the deployed DEX test",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Devices.DeviceDexTest("ListResource", {
            name: TEST_NAME,
            data: {
              host: "https://app.example.com/health",
              kind: "http",
              method: "GET",
            },
            interval: "0h30m0s",
            description: "list",
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Devices.DeviceDexTest,
      );
      const all = yield* provider.list();

      expect(all.some((t) => t.testId === deployed.testId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(entitled)(
  "list returns a well-typed empty array on unentitled accounts",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Devices.DeviceDexTest,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
