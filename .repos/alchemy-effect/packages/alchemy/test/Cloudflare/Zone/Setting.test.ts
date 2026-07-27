import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zones from "@distilled.cloud/cloudflare/zones";
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

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s
// with "Unable to authenticate request". Ride out the blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error (part of
// each setting operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getSetting = (zoneId: string, settingId: string) =>
  zones.getSetting({ zoneId, settingId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize a setting to a known baseline so each run starts from the same
// cloud state regardless of what a previous (possibly interrupted) run left
// behind.
const setBaseline = (zoneId: string, settingId: string, value: unknown) =>
  zones.patchSetting({ zoneId, settingId, value }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const valueOf = (setting: zones.GetSettingResponse): unknown =>
  (setting as { value?: unknown }).value;

test.provider(
  "pins a toggle setting and restores the original value on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      // Known baseline: always_online defaults to "on".
      yield* setBaseline(zoneId, "always_online", "on");

      const setting = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone.Setting("AlwaysOnline", {
            zoneId,
            settingId: "always_online",
            value: "off",
          });
        }),
      );

      expect(setting.zoneId).toEqual(zoneId);
      expect(setting.settingId).toEqual("always_online");
      expect(setting.value).toEqual("off");
      // The pre-management value was captured for restore-on-destroy.
      expect(setting.initialValue).toEqual("on");

      const live = yield* getSetting(zoneId, "always_online");
      expect(valueOf(live)).toEqual("off");

      yield* stack.destroy();

      // Destroy restored the value the setting had before we managed it.
      const restored = yield* getSetting(zoneId, "always_online");
      expect(valueOf(restored)).toEqual("on");
    }).pipe(logLevel),
);

test.provider(
  "updates a numeric setting in place and keeps the captured initial value",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      // Known baseline: browser_cache_ttl defaults to 14400 (4 hours).
      yield* setBaseline(zoneId, "browser_cache_ttl", 14400);

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone.Setting("BrowserCacheTtl", {
            zoneId,
            settingId: "browser_cache_ttl",
            value: 1800,
          });
        }),
      );

      expect(initial.value).toEqual(1800);
      expect(initial.initialValue).toEqual(14400);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone.Setting("BrowserCacheTtl", {
            zoneId,
            settingId: "browser_cache_ttl",
            value: 3600,
          });
        }),
      );

      // Same singleton patched in place; the original value survives the
      // update so destroy still restores the pre-management state.
      expect(updated.value).toEqual(3600);
      expect(updated.initialValue).toEqual(14400);

      const live = yield* getSetting(zoneId, "browser_cache_ttl");
      expect(valueOf(live)).toEqual(3600);

      yield* stack.destroy();

      const restored = yield* getSetting(zoneId, "browser_cache_ttl");
      expect(valueOf(restored)).toEqual(14400);
    }).pipe(logLevel),
);

test.provider(
  "changing settingId replaces — old setting restored, new setting pinned",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      // Known baselines: browser_check and email_obfuscation default to "on".
      yield* setBaseline(zoneId, "browser_check", "on");
      yield* setBaseline(zoneId, "email_obfuscation", "on");

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone.Setting("ReplaceSetting", {
            zoneId,
            settingId: "browser_check",
            value: "off",
          });
        }),
      );

      expect(first.settingId).toEqual("browser_check");
      const firstLive = yield* getSetting(zoneId, "browser_check");
      expect(valueOf(firstLive)).toEqual("off");

      // settingId is the resource's identity — switching it is a
      // replacement: the new setting gets pinned and the old setting is
      // restored to its pre-management value as the old instance deletes.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone.Setting("ReplaceSetting", {
            zoneId,
            settingId: "email_obfuscation",
            value: "off",
          });
        }),
      );

      expect(replaced.settingId).toEqual("email_obfuscation");
      expect(replaced.initialValue).toEqual("on");

      const newLive = yield* getSetting(zoneId, "email_obfuscation");
      expect(valueOf(newLive)).toEqual("off");

      const oldRestored = yield* getSetting(zoneId, "browser_check");
      expect(valueOf(oldRestored)).toEqual("on");

      yield* stack.destroy();

      const finalRestored = yield* getSetting(zoneId, "email_obfuscation");
      expect(valueOf(finalRestored)).toEqual("on");
    }).pipe(logLevel),
);

// Canonical `list()` test. Zone settings are keyed by (zoneId, settingId):
// `list()` enumerates every zone via `listAllZones` and reads each known
// setting, emitting one Attributes per (zone, setting) — the same shape
// `read` produces. Deploy a deterministic setting on the standing test zone
// and assert that exact (zone, setting) entry shows up in the listing.
test.provider("list enumerates the deployed (zone, setting) pair", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    // Known baseline so the value we assert against is deterministic.
    yield* setBaseline(zoneId, "always_use_https", "off");

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Zone.Setting("AlwaysUseHttps", {
          zoneId,
          settingId: "always_use_https",
          value: "on",
        });
      }),
    );
    expect(deployed.settingId).toEqual("always_use_https");
    expect(deployed.value).toEqual("on");

    const provider = yield* Provider.findProvider(Cloudflare.Zone.Setting);
    const all = yield* provider.list();

    // The deployed (zone, setting) pair is present, hydrated into the exact
    // `read`/`Attributes` shape (one row per (zoneId, settingId)).
    expect(all.length).toBeGreaterThan(0);
    const entry = all.find(
      (s) => s.zoneId === zoneId && s.settingId === "always_use_https",
    );
    expect(entry).toBeDefined();
    expect(entry?.value).toEqual("on");

    yield* stack.destroy();

    // Capture-and-restore: destroy put the setting back to its baseline.
    const restored = yield* getSetting(zoneId, "always_use_https");
    expect(valueOf(restored)).toEqual("off");
  }).pipe(logLevel),
);
