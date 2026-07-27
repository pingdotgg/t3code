import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as mnm from "@distilled.cloud/cloudflare/magic-network-monitoring";
import { describe, expect } from "alchemy-test";
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
const forbiddenRetry = {
  while: (e: { _tag: string }) => e._tag === "Forbidden",
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

// Cloudflare answers HTTP 200 with `result: null` when no MNM config
// exists; the distilled core client decodes that as an empty object, so a
// config without its required `name` field means "no config".
const getConfig = (accountId: string) =>
  mnm.getConfig({ accountId }).pipe(
    Effect.map((config) =>
      config === null || config.name == null ? undefined : config,
    ),
    Effect.retry(forbiddenRetry),
  );

const getRule = (accountId: string, ruleId: string) =>
  mnm.getRule({ accountId, ruleId }).pipe(Effect.retry(forbiddenRetry));

const expectRuleGone = (accountId: string, ruleId: string) =>
  getRule(accountId, ruleId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "RuleNotDeleted" } as const)),
    // A missing rule surfaces as `MnmRuleNotFound` (Cloudflare error code
    // 1009) — that's the success condition here.
    Effect.catchTag("MnmRuleNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "RuleNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

const expectConfigGone = (accountId: string) =>
  getConfig(accountId).pipe(
    Effect.flatMap((config) =>
      config === undefined
        ? Effect.void
        : Effect.fail({ _tag: "ConfigNotDeleted" } as const),
    ),
    Effect.retry({
      while: (e) => e._tag === "ConfigNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

describe.sequential("MagicNetworkMonitoring", () => {
  test.provider(
    "creates, updates in place, and deletes the account config",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();
        // The config is an account singleton — normalize to "absent" so the
        // run starts from a known baseline even after an interrupted run.
        yield* mnm.deleteConfig({ accountId }).pipe(
          Effect.catchTag("MnmConfigNotFound", () => Effect.void),
          Effect.retry(forbiddenRetry),
        );

        const config = yield* stack.deploy(
          Cloudflare.MagicNetworkMonitoring.Config("Config", {
            name: "alchemy-mnm-test",
            defaultSampling: 1,
          }),
        );

        expect(config.accountId).toEqual(accountId);
        expect(config.name).toEqual("alchemy-mnm-test");
        expect(config.defaultSampling).toEqual(1);
        expect(config.routerIps).toEqual([]);

        const live = yield* getConfig(accountId);
        expect(live?.name).toEqual("alchemy-mnm-test");
        expect(live?.defaultSampling).toEqual(1);

        // Update the name label + sampling in place (same singleton).
        // Registering `routerIps` requires the router-flow entitlement
        // (Cloudflare rejects any non-empty value with code 1003,
        // `InvalidMnmConfig`, on this account), so only the always-available
        // fields are exercised here.
        const updated = yield* stack.deploy(
          Cloudflare.MagicNetworkMonitoring.Config("Config", {
            name: "alchemy-mnm-test-v2",
            defaultSampling: 100,
          }),
        );

        expect(updated.accountId).toEqual(accountId);
        expect(updated.name).toEqual("alchemy-mnm-test-v2");
        expect(updated.defaultSampling).toEqual(100);

        const liveUpdated = yield* getConfig(accountId);
        expect(liveUpdated?.name).toEqual("alchemy-mnm-test-v2");
        expect(liveUpdated?.defaultSampling).toEqual(100);

        // Redeploying identical props is a no-op.
        const noop = yield* stack.deploy(
          Cloudflare.MagicNetworkMonitoring.Config("Config", {
            name: "alchemy-mnm-test-v2",
            defaultSampling: 100,
          }),
        );
        expect(noop.name).toEqual("alchemy-mnm-test-v2");

        yield* stack.destroy();
        yield* expectConfigGone(accountId);

        // Destroy is idempotent — a second destroy of an already-deleted
        // config must not fail.
        yield* stack.destroy();
      }).pipe(logLevel),
  );

  test.provider(
    "creates a threshold rule, updates it in place, and replaces on type change",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();
        // The config is an account singleton with no ownership markers — a
        // leftover from an interrupted run would surface as `Unowned` and
        // block this stack's create, so normalize to "absent" first.
        yield* mnm.deleteConfig({ accountId }).pipe(
          Effect.catchTag("MnmConfigNotFound", () => Effect.void),
          Effect.retry(forbiddenRetry),
        );

        const deployRule = (props: {
          name: string;
          type: "threshold" | "zscore";
          prefixes: string[];
          bandwidthThreshold?: number;
          duration?: "1m" | "5m";
          zscoreSensitivity?: "low" | "medium" | "high";
          zscoreTarget?: "bits" | "packets";
        }) =>
          stack.deploy(
            Effect.gen(function* () {
              const config = yield* Cloudflare.MagicNetworkMonitoring.Config(
                "Config",
                {
                  name: "alchemy-mnm-rule-test",
                  defaultSampling: 1,
                },
              );
              // Rules cannot exist without the account config — sequence the
              // rule after the config via its accountId output.
              const rule = yield* Cloudflare.MagicNetworkMonitoring.Rule(
                "Rule",
                {
                  accountId: config.accountId,
                  ...props,
                },
              );
              return { config, rule };
            }),
          );

        const { rule } = yield* deployRule({
          name: "alchemy-mnm-rule",
          type: "threshold",
          prefixes: ["10.0.0.0/24"],
          bandwidthThreshold: 1_000_000,
          duration: "1m",
        });

        expect(rule.ruleId).toBeDefined();
        expect(rule.accountId).toEqual(accountId);
        expect(rule.name).toEqual("alchemy-mnm-rule");
        expect(rule.type).toEqual("threshold");
        expect(rule.prefixes).toEqual(["10.0.0.0/24"]);
        expect(rule.bandwidthThreshold).toEqual(1_000_000);

        const live = yield* getRule(accountId, rule.ruleId);
        expect(live.name).toEqual("alchemy-mnm-rule");
        expect(live.type).toEqual("threshold");
        expect(live.prefixes).toEqual(["10.0.0.0/24"]);

        // Update mutable props in place — same rule id.
        const { rule: updated } = yield* deployRule({
          name: "alchemy-mnm-rule-v2",
          type: "threshold",
          prefixes: ["10.0.0.0/24", "10.0.1.0/24"],
          bandwidthThreshold: 2_000_000,
          duration: "5m",
        });

        expect(updated.ruleId).toEqual(rule.ruleId);
        expect(updated.name).toEqual("alchemy-mnm-rule-v2");
        expect([...updated.prefixes].sort()).toEqual([
          "10.0.0.0/24",
          "10.0.1.0/24",
        ]);
        expect(updated.bandwidthThreshold).toEqual(2_000_000);

        const liveUpdated = yield* getRule(accountId, rule.ruleId);
        expect(liveUpdated.name).toEqual("alchemy-mnm-rule-v2");
        expect([...liveUpdated.prefixes].sort()).toEqual([
          "10.0.0.0/24",
          "10.0.1.0/24",
        ]);

        // `type` is immutable — switching threshold → zscore replaces the
        // rule (new rule id). The name changes too: rule names are unique
        // per account and the replacement creates the new rule before
        // deleting the old one.
        const { rule: replaced } = yield* deployRule({
          name: "alchemy-mnm-rule-zscore",
          type: "zscore",
          prefixes: ["10.0.0.0/24"],
          zscoreSensitivity: "medium",
          zscoreTarget: "bits",
        });

        expect(replaced.ruleId).not.toEqual(rule.ruleId);
        expect(replaced.type).toEqual("zscore");
        expect(replaced.zscoreSensitivity).toEqual("medium");
        expect(replaced.zscoreTarget).toEqual("bits");

        // The old rule was deleted as part of the replacement.
        yield* expectRuleGone(accountId, rule.ruleId);

        const liveReplaced = yield* getRule(accountId, replaced.ruleId);
        expect(liveReplaced.type).toEqual("zscore");

        yield* stack.destroy();

        yield* expectRuleGone(accountId, replaced.ruleId);
        yield* expectConfigGone(accountId);
      }).pipe(logLevel),
    { timeout: 120_000 },
  );
});
