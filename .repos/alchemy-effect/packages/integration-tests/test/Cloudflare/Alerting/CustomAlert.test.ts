import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as alerting from "@distilled.cloud/cloudflare/alerting";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const EMAIL = "test@alchemy.run";

const errorCount = (accountId: string) =>
  `SELECT count() AS value FROM logs.workersLogs WHERE accountTag = '${accountId}' AND level = 'error'`;

// Every alert is disabled so the tests never evaluate queries or send mail.
const alert = (accountId: string, trigger: Cloudflare.Alerting.CustomAlertTrigger) =>
  Cloudflare.Alerting.CustomAlert("Alert", {
    query: errorCount(accountId),
    trigger,
    every: "5m",
    enabled: false,
    mechanisms: { email: [{ id: EMAIL }] },
  });

test.provider(
  "create, update, delete a threshold alert",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const threshold = (value: number) =>
        alert(accountId, { type: "threshold", operator: ">", value, window: "5m" });

      const created = yield* stack.deploy(threshold(100));
      expect(created.accountId).toEqual(accountId);
      expect(created.enabled).toBe(false);

      // Verify out-of-band: the trigger object is stored as the
      // custom_analytics filters.
      const policy = yield* alerting.getPolicy({ accountId, policyId: created.policyId });
      expect(policy.alertType).toEqual("custom_analytics");
      expect(policy.filters).toEqual({
        source: ["sql_api"],
        selectors: [errorCount(accountId)],
        executionInterval: ["5m"],
        alertTriggerPreferences: ["threshold"],
        alertTriggerPreferencesOperator: [">"],
        alertTriggerPreferencesValue: ["100"],
        alertTriggerPreferencesShortWindow: ["5m"],
      });

      // The stored filters match what we send, so a redeploy does not PUT.
      yield* stack.deploy(threshold(100));
      const unchanged = yield* alerting.getPolicy({ accountId, policyId: created.policyId });
      expect(unchanged.modified).toEqual(policy.modified);

      // Changing the value updates in place.
      const updated = yield* stack.deploy(threshold(250));
      expect(updated.policyId).toEqual(created.policyId);
      const afterUpdate = yield* alerting.getPolicy({ accountId, policyId: created.policyId });
      expect(afterUpdate.filters?.alertTriggerPreferencesValue).toEqual(["250"]);

      yield* stack.destroy();

      yield* waitForPolicyDeleted(accountId, created.policyId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:alerting", "live"] },
);

test.provider(
  "switches between threshold, anomaly and SLO triggers in place",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        alert(accountId, { type: "threshold", operator: "<=", value: 5, window: "10m" }),
      );

      const anomaly = yield* stack.deploy(
        alert(accountId, {
          type: "anomaly",
          direction: "both",
          zScore: 3,
          window: "5m",
          baselineWindow: "1h",
          minimumThreshold: 10,
        }),
      );
      expect(anomaly.policyId).toEqual(created.policyId);
      const anomalyPolicy = yield* alerting.getPolicy({ accountId, policyId: created.policyId });
      expect(anomalyPolicy.filters?.alertTriggerPreferences).toEqual(["zscore_spike_and_drop"]);
      expect(anomalyPolicy.filters?.alertTriggerPreferencesValue).toEqual(["3"]);
      expect(anomalyPolicy.filters?.alertTriggerPreferencesLongWindow).toEqual(["1h"]);
      expect(anomalyPolicy.filters?.alertTriggerPreferencesMinimumThreshold).toEqual(["10"]);

      const slo = yield* stack.deploy(
        alert(accountId, { type: "slo", target: 99.9, shortWindow: "5m", longWindow: "1h" }),
      );
      expect(slo.policyId).toEqual(created.policyId);
      const sloPolicy = yield* alerting.getPolicy({ accountId, policyId: created.policyId });
      expect(sloPolicy.filters?.alertTriggerPreferences).toEqual(["slo"]);
      expect(sloPolicy.filters?.alertTriggerPreferencesValue).toEqual(["99.9"]);
      expect(sloPolicy.filters?.alertTriggerPreferencesMinimumThreshold).toBeUndefined();

      yield* stack.destroy();

      yield* waitForPolicyDeleted(accountId, created.policyId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:alerting", "live"] },
);

test.provider(
  "rejects a query the SQL API refuses",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Cloudflare.Alerting.CustomAlert("BadQuery", {
            // No account scope: the SQL API rejects the query.
            query: "SELECT count() AS value FROM logs.workersLogs",
            trigger: { type: "threshold", operator: ">", value: 100, window: "5m" },
            enabled: false,
            mechanisms: { email: [{ id: EMAIL }] },
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidAlertQuery");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:alerting", "live"] },
);

test.provider(
  "list enumerates the deployed custom alert",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        alert(accountId, { type: "threshold", operator: ">", value: 1, window: "5m" }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Alerting.CustomAlert);
      const all = yield* provider.list();

      expect(all.some((a) => a.policyId === deployed.policyId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:alerting", "live"] },
);

const waitForPolicyDeleted = (accountId: string, policyId: string) =>
  alerting.getPolicy({ accountId, policyId }).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "PolicyNotDeleted" } as const)),
    Effect.catchTag("PolicyNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "PolicyNotDeleted",
      schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(10)]),
    }),
  );
