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

// Ride out 403 blips (`Forbidden`) while the harness-minted token
// propagates across Cloudflare's edge.
const getConfiguration = (accountId: string) =>
  zeroTrust.getGatewayConfiguration({ accountId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// Seed a deterministic baseline for the blocks under management. Blocks
// that were never set on the account cannot be restored (Cloudflare's
// PATCH ignores `null`), so the capture-and-restore assertion needs the
// blocks to exist with known values before the stack manages them.
const seedBaseline = (accountId: string) =>
  zeroTrust
    .patchGatewayConfiguration({
      accountId,
      settings: {
        activityLog: { enabled: true },
        protocolDetection: { enabled: false },
      },
    })
    .pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: Schedule.exponential("500 millis"),
        times: 8,
      }),
    );

test.provider(
  "manage activityLog and protocolDetection, then restore on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Seed and capture a deterministic pre-test state out-of-band so
      // we can verify the capture-and-restore behaviour at the end.
      yield* seedBaseline(accountId);
      const baseline = yield* getConfiguration(accountId);
      const baselineActivityLog = baseline.settings?.activityLog?.enabled;
      const baselineProtocolDetection =
        baseline.settings?.protocolDetection?.enabled;
      expect(baselineActivityLog).toEqual(true);
      expect(baselineProtocolDetection).toEqual(false);

      // Drive both toggles to the opposite of the baseline so the deploy
      // is guaranteed to change something.
      const flippedActivityLog = false;
      const flippedProtocolDetection = true;

      const config = yield* stack.deploy(
        Cloudflare.Gateway.Configuration("Gateway", {
          settings: {
            activityLog: { enabled: flippedActivityLog },
            protocolDetection: { enabled: flippedProtocolDetection },
          },
        }),
      );
      expect(config.accountId).toEqual(accountId);
      // The pre-management blocks were captured for restore.
      expect(Object.keys(config.initialSettings).sort()).toEqual([
        "activityLog",
        "protocolDetection",
      ]);

      const live = yield* getConfiguration(accountId);
      expect(live.settings?.activityLog?.enabled).toEqual(flippedActivityLog);
      expect(live.settings?.protocolDetection?.enabled).toEqual(
        flippedProtocolDetection,
      );

      // Update in place — flip activityLog back; protocolDetection stays.
      const updated = yield* stack.deploy(
        Cloudflare.Gateway.Configuration("Gateway", {
          settings: {
            activityLog: { enabled: !flippedActivityLog },
            protocolDetection: { enabled: flippedProtocolDetection },
          },
        }),
      );
      // The original capture survives the update.
      expect(updated.initialSettings).toEqual(config.initialSettings);

      const liveAfter = yield* getConfiguration(accountId);
      expect(liveAfter.settings?.activityLog?.enabled).toEqual(
        !flippedActivityLog,
      );

      // Destroy restores the captured pre-management values.
      yield* stack.destroy();
      const restored = yield* getConfiguration(accountId);
      expect(restored.settings?.activityLog?.enabled).toEqual(
        baselineActivityLog,
      );
      expect(restored.settings?.protocolDetection?.enabled).toEqual(
        baselineProtocolDetection,
      );
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list returns the account Gateway configuration singleton",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId } = yield* yield* CloudflareEnvironment;

      const provider = yield* Provider.findProvider(
        Cloudflare.Gateway.Configuration,
      );
      const all = yield* provider.list();

      // Account-wide singleton: exactly one element for the ambient account.
      expect(all.length).toEqual(1);
      expect(all[0]!.accountId).toEqual(accountId);
      expect(all[0]!.initialSettings).toEqual({});

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
