import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as realtimeKit from "@distilled.cloud/cloudflare/realtime-kit";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// RealtimeKit is beta / entitlement-gated — unentitled accounts get the
// typed `Forbidden` (403) on every call. Probe and no-op when unentitled;
// the App suite pins the typed tag.
const probeEntitlement = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* realtimeKit.getApp({ accountId }).pipe(
    Effect.as(true),
    Effect.catchTag("Forbidden", () => Effect.succeed(false)),
  );
});

const getPreset = (accountId: string, appId: string, presetId: string) =>
  realtimeKit.getPresetByIdPreset({ accountId, appId, presetId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
    Effect.map((res) => res.data),
  );

// Poll until the preset is gone after destroy — Cloudflare answers GET for
// a missing preset with the typed `RealtimeKitPresetNotFound` (404).
const expectGone = (accountId: string, appId: string, presetId: string) =>
  getPreset(accountId, appId, presetId).pipe(
    Effect.asSome,
    Effect.catchTag("RealtimeKitPresetNotFound", () => Effect.succeedNone),
    Effect.repeat({
      schedule: Schedule.exponential("500 millis"),
      until: Option.isNone,
      times: 8,
    }),
    Effect.map((preset) => expect(Option.isNone(preset)).toBe(true)),
  );

// Deterministic names — apps cannot be deleted, so every run adopts the
// same app instead of leaking a new one. Each test gets its own preset
// name: the suites run concurrently (`sequence.concurrent`) and a shared
// preset name would make two stacks create the same preset in the same app
// and race to a 409.
const APP_NAME = "alchemy-rtk-test-app";
const LIFECYCLE_PRESET_NAME = "alchemy-rtk-test-preset-lifecycle";
const LIST_PRESET_NAME = "alchemy-rtk-test-preset-list";

test.provider(
  "create with defaults, verify out-of-band, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const entitled = yield* probeEntitlement;
      if (!entitled) {
        yield* Effect.logInfo(
          "account is not RealtimeKit-entitled; skipping lifecycle",
        );
        return;
      }

      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create — preset with all-default config / ui / permissions.
      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.RealtimeKit.App("App", {
            name: APP_NAME,
          });
          return yield* Cloudflare.RealtimeKit.Preset("Preset", {
            appId: app.appId,
            name: LIFECYCLE_PRESET_NAME,
          });
        }),
      );

      expect(v1.presetId).toBeTruthy();
      expect(v1.accountId).toEqual(accountId);
      expect(v1.name).toEqual(LIFECYCLE_PRESET_NAME);
      expect(v1.config.viewType).toEqual("GROUP_CALL");
      expect(v1.permissions?.canRecord).toBe(false);

      // Out-of-band verification via the distilled API.
      const live = yield* getPreset(accountId, v1.appId, v1.presetId);
      expect(live.name).toEqual(LIFECYCLE_PRESET_NAME);
      expect(live.config.viewType).toEqual("GROUP_CALL");

      // In-place update — grant recording + moderation. Same preset (no
      // replacement).
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.RealtimeKit.App("App", {
            name: APP_NAME,
          });
          return yield* Cloudflare.RealtimeKit.Preset("Preset", {
            appId: app.appId,
            name: LIFECYCLE_PRESET_NAME,
            permissions: {
              ...Cloudflare.RealtimeKit.defaultRealtimeKitPresetPermissions(),
              canRecord: true,
              kickParticipant: true,
              pinParticipant: true,
            },
          });
        }),
      );

      expect(v2.presetId).toEqual(v1.presetId);
      expect(v2.permissions?.canRecord).toBe(true);
      expect(v2.permissions?.kickParticipant).toBe(true);

      const updated = yield* getPreset(accountId, v2.appId, v2.presetId);
      expect(updated.permissions?.canRecord).toBe(true);

      // Idempotent re-deploy — reconcile must detect the no-op.
      const v3 = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.RealtimeKit.App("App", {
            name: APP_NAME,
          });
          return yield* Cloudflare.RealtimeKit.Preset("Preset", {
            appId: app.appId,
            name: LIFECYCLE_PRESET_NAME,
            permissions: {
              ...Cloudflare.RealtimeKit.defaultRealtimeKitPresetPermissions(),
              canRecord: true,
              kickParticipant: true,
              pinParticipant: true,
            },
          });
        }),
      );
      expect(v3.presetId).toEqual(v1.presetId);

      // Destroy — the preset must be deleted (the app remains; it has no
      // delete API).
      yield* stack.destroy();
      yield* expectGone(accountId, v1.appId, v1.presetId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed preset",
  (stack) =>
    Effect.gen(function* () {
      const entitled = yield* probeEntitlement;
      if (!entitled) {
        // RealtimeKit beta is entitlement-gated: an unentitled account gets the
        // typed `Forbidden` (403) on `getApp`, which `list()` propagates. Skip
        // the live assertion; the App suite pins the typed tag.
        yield* Effect.logInfo(
          "account is not RealtimeKit-entitled; skipping list",
        );
        return;
      }

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.RealtimeKit.App("App", {
            name: APP_NAME,
          });
          return yield* Cloudflare.RealtimeKit.Preset("Preset", {
            appId: app.appId,
            name: LIST_PRESET_NAME,
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.RealtimeKit.Preset,
      );
      const all = yield* provider.list();

      expect(
        all.some(
          (p) => p.presetId === deployed.presetId && p.appId === deployed.appId,
        ),
      ).toBe(true);
      const found = all.find((p) => p.presetId === deployed.presetId);
      expect(found?.name).toEqual(LIST_PRESET_NAME);
      expect(found?.config.viewType).toEqual("GROUP_CALL");

      yield* stack.destroy();
      yield* expectGone(deployed.accountId, deployed.appId, deployed.presetId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
