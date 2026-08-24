import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as aiSecurity from "@distilled.cloud/cloudflare/ai-security";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// AI Security for Apps (Firewall for AI) is entitlement-gated — on the
// standard testing account every call fails with "not entitled to access
// this resource" (code 13101), surfaced as the typed `AiSecurityNotEntitled`
// error. The full lifecycle test below is gated behind an entitled zone id
// supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_AI_SECURITY_ZONE_ID;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getSettings = (zoneId: string) =>
  aiSecurity.getAiSecurity({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize the setting to a known baseline so each run starts from the
// same cloud state regardless of what a previous run left behind.
const setBaseline = (zoneId: string, enabled: boolean) =>
  aiSecurity.putAiSecurity({ zoneId, enabled }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "surfaces the typed AiSecurityNotEntitled error on unentitled accounts",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The testing account lacks the AI Security entitlement — the
      // distilled call must fail with the typed entitlement tag (never
      // the catch-all `Forbidden`/`UnknownCloudflareError`).
      const error = yield* getSettings(zoneId).pipe(Effect.flip);
      expect(error._tag).toEqual("AiSecurityNotEntitled");

      const topicsError = yield* aiSecurity.getCustomTopic({ zoneId }).pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: forbiddenRetrySchedule,
          times: 8,
        }),
        Effect.flip,
      );
      expect(topicsError._tag).toEqual("AiSecurityNotEntitled");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Canonical `list()` test (zone-scoped singleton): there is no account-wide
// API for this per-zone setting, so `list()` enumerates every zone via
// `listAllZones` and reads the singleton in each, skipping zones that reject
// the route (AI Security is entitlement-gated). It always returns a well-typed
// `Attributes[]` — empty on the unentitled testing account, non-empty and
// containing the entitled zone when one is supplied via env.
test.provider(
  "list enumerates the setting across all entitled zones",
  (stack) =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(
        Cloudflare.AI.SecuritySettings,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      // Every element is the full Attributes shape `read` produces.
      for (const settings of all) {
        expect(typeof settings.zoneId).toBe("string");
        expect(typeof settings.enabled).toBe("boolean");
        expect(typeof settings.initialEnabled).toBe("boolean");
      }
      // On an entitled account, the supplied zone must appear in the result.
      if (entitledZoneId) {
        expect(all.some((s) => s.zoneId === entitledZoneId)).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!entitledZoneId)(
  "pins enabled, updates in place, and restores the original on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;

      yield* stack.destroy();
      // Known baseline: AI Security disabled.
      yield* setBaseline(zoneId, false);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AI.SecuritySettings("AiSecurity", {
            zoneId,
            enabled: true,
          });
        }),
      );

      expect(created.zoneId).toEqual(zoneId);
      expect(created.enabled).toEqual(true);
      // The pre-management value was captured for restore-on-destroy.
      expect(created.initialEnabled).toEqual(false);

      // Out-of-band verification via the distilled API.
      const live = yield* getSettings(zoneId);
      expect(live.enabled ?? false).toEqual(true);

      // Update in place — same singleton, initial value survives.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AI.SecuritySettings("AiSecurity", {
            zoneId,
            enabled: false,
          });
        }),
      );
      expect(updated.enabled).toEqual(false);
      expect(updated.initialEnabled).toEqual(false);

      const toggled = yield* getSettings(zoneId);
      expect(toggled.enabled ?? false).toEqual(false);

      yield* stack.destroy();

      // Destroy restored the value the zone had before we managed it.
      const restored = yield* getSettings(zoneId);
      expect(restored.enabled ?? false).toEqual(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
