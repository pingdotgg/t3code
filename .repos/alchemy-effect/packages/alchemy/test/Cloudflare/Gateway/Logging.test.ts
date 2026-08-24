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
const getLogging = (accountId: string) =>
  zeroTrust.getGatewayLogging({ accountId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

test.provider(
  "manage logging settings, update in place, restore on destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Capture the account's pre-test state out-of-band so we can
      // verify the capture-and-restore behaviour at the end.
      const baseline = yield* getLogging(accountId);
      const baselineRedactPii = baseline.redactPii ?? undefined;
      const baselineDnsLogAll =
        baseline.settingsByRuleType?.dns?.logAll ?? undefined;

      // Drive both managed fields to the opposite of the baseline so the
      // deploy is guaranteed to change something.
      const flippedRedactPii = !(baselineRedactPii ?? false);
      const flippedDnsLogAll = !(baselineDnsLogAll ?? true);

      const logging = yield* stack.deploy(
        Cloudflare.Gateway.Logging("Logging", {
          redactPii: flippedRedactPii,
          settingsByRuleType: {
            dns: { logAll: flippedDnsLogAll },
          },
        }),
      );
      expect(logging.accountId).toEqual(accountId);
      expect(logging.redactPii).toEqual(flippedRedactPii);
      expect(logging.dns?.logAll).toEqual(flippedDnsLogAll);
      // The pre-management snapshot was captured for restore.
      expect(logging.initialSettings.redactPii ?? undefined).toEqual(
        baselineRedactPii,
      );

      const live = yield* getLogging(accountId);
      expect(live.redactPii).toEqual(flippedRedactPii);
      expect(live.settingsByRuleType?.dns?.logAll).toEqual(flippedDnsLogAll);

      // Update in place — flip redactPii back; the dns toggle stays.
      const updated = yield* stack.deploy(
        Cloudflare.Gateway.Logging("Logging", {
          redactPii: !flippedRedactPii,
          settingsByRuleType: {
            dns: { logAll: flippedDnsLogAll },
          },
        }),
      );
      expect(updated.redactPii).toEqual(!flippedRedactPii);
      expect(updated.dns?.logAll).toEqual(flippedDnsLogAll);
      // The original capture survives the update.
      expect(updated.initialSettings).toEqual(logging.initialSettings);

      // Destroy restores the captured pre-management values.
      yield* stack.destroy();
      const restored = yield* getLogging(accountId);
      expect(restored.redactPii ?? undefined).toEqual(baselineRedactPii);
      expect(restored.settingsByRuleType?.dns?.logAll ?? undefined).toEqual(
        baselineDnsLogAll,
      );
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (account singleton): there is no enumeration API
// for the Gateway logging settings — the object always exists for the
// account. `list()` reads the single instance and returns it as a
// one-element array. Assert exactly one well-typed Attributes for the
// ambient account.
test.provider(
  "list returns the account's Gateway logging singleton",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Cloudflare.Gateway.Logging);
      const all = yield* provider.list();

      expect(all.length).toEqual(1);
      const [settings] = all;
      expect(settings.accountId).toEqual(accountId);
      // The singleton's observed snapshot is its own restore target.
      expect(settings.initialSettings).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
