import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as botManagement from "@distilled.cloud/cloudflare/bot-management";
import { describe, expect } from "alchemy-test";
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
// consistently across Cloudflare's edge — a fresh token intermittently 403s.
// Ride out the blips on the test's own out-of-band verification calls by
// retrying the typed `Forbidden` error (patched into the bot-management
// operations' error unions).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

/**
 * The distilled response is a 4-way union of plan shapes; widen to a flat
 * bag of optional fields for assertions.
 */
interface ObservedConfig {
  readonly enableJs?: boolean | null;
  readonly fightMode?: boolean | null;
  readonly aiBotsProtection?: string | null;
  readonly sbfmDefinitelyAutomated?: string | null;
  readonly sbfmVerifiedBots?: string | null;
  readonly sbfmStaticResourceProtection?: boolean | null;
  readonly optimizeWordpress?: boolean | null;
}

const getConfig = (zoneId: string) =>
  botManagement.getBotManagement({ zoneId }).pipe(
    Effect.map((config): ObservedConfig => config as ObservedConfig),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const restoreSbfm = (zoneId: string, original: ObservedConfig) =>
  Effect.gen(function* () {
    const body: Record<string, unknown> = {};
    if (original.sbfmDefinitelyAutomated != null) {
      body.sbfmDefinitelyAutomated = original.sbfmDefinitelyAutomated;
    }
    if (original.sbfmVerifiedBots != null) {
      body.sbfmVerifiedBots = original.sbfmVerifiedBots;
    }
    if (original.sbfmStaticResourceProtection != null) {
      body.sbfmStaticResourceProtection = original.sbfmStaticResourceProtection;
    }
    if (Object.keys(body).length === 0) return;
    yield* botManagement.putBotManagement({ zoneId, ...body });
  }).pipe(Effect.ignore);

// Setting `sbfm_definitely_automated` to anything but "allow" makes the
// standing zone answer every automated request (curl, fetch, vitest HTTP
// assertions) with a managed challenge — breaking every live suite that
// drives the zone over HTTP, and an interrupted run leaves the setting
// behind. The mutating lifecycle tests are therefore opt-in; the adopt and
// list tests below always run.
const destructive = !!process.env.CLOUDFLARE_TEST_BOT_MANAGEMENT;

describe.sequential("BotManagement", () => {
  test.provider.skipIf(!destructive)(
    "manages SBFM settings on the zone singleton and restores them on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        const original = yield* getConfig(zoneId);
        // Pick deterministic targets that differ from the live config so the
        // first reconcile demonstrably writes.
        const target =
          original.sbfmDefinitelyAutomated === "managed_challenge"
            ? "block"
            : ("managed_challenge" as const);
        const target2 = target === "block" ? "managed_challenge" : "block";

        yield* Effect.gen(function* () {
          // 1. Create (adopt the singleton) with one SBFM field set.
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.BotManagement.BotManagement("Bots", {
                zoneId,
                sbfmDefinitelyAutomated: target,
              });
            }),
          );
          expect(created.zoneId).toEqual(zoneId);
          expect(created.sbfmDefinitelyAutomated).toEqual(target);
          // Snapshot captured the pre-management value.
          expect(
            created.initialSettings.sbfmDefinitelyAutomated ?? null,
          ).toEqual(original.sbfmDefinitelyAutomated ?? null);

          const live1 = yield* getConfig(zoneId);
          expect(live1.sbfmDefinitelyAutomated).toEqual(target);

          // 2. Update the mutable field — same singleton (same zoneId), and
          //    the initial snapshot must remain sticky across updates.
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.BotManagement.BotManagement("Bots", {
                zoneId,
                sbfmDefinitelyAutomated: target2,
              });
            }),
          );
          expect(updated.zoneId).toEqual(zoneId);
          expect(updated.sbfmDefinitelyAutomated).toEqual(target2);
          expect(
            updated.initialSettings.sbfmDefinitelyAutomated ?? null,
          ).toEqual(original.sbfmDefinitelyAutomated ?? null);

          const live2 = yield* getConfig(zoneId);
          expect(live2.sbfmDefinitelyAutomated).toEqual(target2);

          // 3. Destroy — the managed field is restored to the snapshot value
          //    (when the snapshot had one; the test zone always does once the
          //    field has ever been set, which step 1 guarantees for reruns).
          yield* stack.destroy();

          const after = yield* getConfig(zoneId);
          if (original.sbfmDefinitelyAutomated != null) {
            expect(after.sbfmDefinitelyAutomated).toEqual(
              original.sbfmDefinitelyAutomated,
            );
          }
        }).pipe(Effect.ensuring(restoreSbfm(zoneId, original)));

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 240_000 },
  );

  test.provider(
    "deploy with no settings set adopts the singleton without writing",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        const before = yield* getConfig(zoneId);

        const adopted = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.BotManagement.BotManagement("Bots", {
              zoneId,
            });
          }),
        );
        expect(adopted.zoneId).toEqual(zoneId);

        // Nothing was set => no PUT => live config unchanged.
        const afterDeploy = yield* getConfig(zoneId);
        expect(afterDeploy.sbfmDefinitelyAutomated ?? null).toEqual(
          before.sbfmDefinitelyAutomated ?? null,
        );
        expect(afterDeploy.sbfmVerifiedBots ?? null).toEqual(
          before.sbfmVerifiedBots ?? null,
        );
        expect(afterDeploy.sbfmStaticResourceProtection ?? null).toEqual(
          before.sbfmStaticResourceProtection ?? null,
        );
        expect(afterDeploy.enableJs ?? null).toEqual(before.enableJs ?? null);

        // Destroy of an untouched singleton restores nothing and never errors.
        yield* stack.destroy();

        const afterDestroy = yield* getConfig(zoneId);
        expect(afterDestroy.sbfmDefinitelyAutomated ?? null).toEqual(
          before.sbfmDefinitelyAutomated ?? null,
        );
        expect(afterDestroy.enableJs ?? null).toEqual(before.enableJs ?? null);
      }).pipe(logLevel),
    { timeout: 240_000 },
  );

  test.provider.skipIf(!destructive)(
    "toggles a boolean SBFM field and restores it on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        const original = yield* getConfig(zoneId);
        const toggled = !(original.sbfmStaticResourceProtection ?? false);

        yield* Effect.gen(function* () {
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.BotManagement.BotManagement("Bots", {
                zoneId,
                sbfmStaticResourceProtection: toggled,
              });
            }),
          );
          expect(created.sbfmStaticResourceProtection).toEqual(toggled);

          const live = yield* getConfig(zoneId);
          expect(live.sbfmStaticResourceProtection).toEqual(toggled);

          yield* stack.destroy();

          const after = yield* getConfig(zoneId);
          if (original.sbfmStaticResourceProtection != null) {
            expect(after.sbfmStaticResourceProtection).toEqual(
              original.sbfmStaticResourceProtection,
            );
          }
        }).pipe(Effect.ensuring(restoreSbfm(zoneId, original)));

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 240_000 },
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone config, so `list()` enumerates every zone via
  // `listAllZones` and reads the bot-management singleton in each. Assert the
  // result is non-empty and contains the standing test zone. This is a
  // read-only assertion (no mutation), so it runs regardless of whether the
  // zone has the paid Bot Management add-on.
  test.provider(
    "list enumerates bot management across all zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        const provider = yield* Provider.findProvider(
          Cloudflare.BotManagement.BotManagement,
        );
        const all = yield* provider.list();

        expect(all.length).toBeGreaterThan(0);
        expect(all.some((s) => s.zoneId === zoneId)).toBe(true);

        // `stack` is unused (the singleton always exists on every zone), but
        // keep the destroy bookend so the harness state stays clean.
        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 240_000 },
  );
});
