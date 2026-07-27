import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as mnm from "@distilled.cloud/cloudflare/magic-network-monitoring";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
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
// (`Forbidden`, declared in the distilled error union) on the test's own
// out-of-band setup calls.
const forbiddenRetry = {
  while: (e: { _tag: string }) => e._tag === "Forbidden",
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

class MnmRuleNotListed extends Data.TaggedError("MnmRuleNotListed")<{}> {}

// Canonical `list()` test (account-scoped collection): deploy a config +
// rule, then resolve the provider via the typed `Provider.findProvider`
// helper and assert the deployed rule appears in the exhaustively-
// paginated `list()` result.
describe.sequential("MagicNetworkMonitoring.Rule", () => {
  test.provider("list enumerates the deployed rule", (stack) =>
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

      const { rule } = yield* stack.deploy(
        Effect.gen(function* () {
          const config = yield* Cloudflare.MagicNetworkMonitoring.Config(
            "Config",
            {
              name: "alchemy-mnm-list-test",
              defaultSampling: 1,
            },
          );
          // Rules cannot exist without the account config — sequence the
          // rule after the config via its accountId output.
          const rule = yield* Cloudflare.MagicNetworkMonitoring.Rule("Rule", {
            accountId: config.accountId,
            type: "threshold",
            prefixes: ["10.0.0.0/24"],
            bandwidthThreshold: 1_000_000,
            duration: "1m",
          });
          return { config, rule };
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicNetworkMonitoring.Rule,
      );
      const all = yield* provider.list().pipe(
        Effect.flatMap((all) =>
          all.some((r) => r.ruleId === rule.ruleId)
            ? Effect.succeed(all)
            : Effect.fail(new MnmRuleNotListed()),
        ),
        Effect.retry({
          while: (e) => e._tag === "MnmRuleNotListed",
          schedule: Schedule.max([
            Schedule.exponential("500 millis"),
            Schedule.recurs(10),
          ]),
        }),
      );

      // The exhaustively-paginated result contains the deployed rule, and
      // each element carries the full `read` Attributes shape.
      const found = all.find((r) => r.ruleId === rule.ruleId);
      expect(found).toBeDefined();
      expect(found?.accountId).toEqual(accountId);
      expect(found?.name).toEqual(rule.name);
      expect(found?.type).toEqual("threshold");
      expect(found?.prefixes).toEqual(["10.0.0.0/24"]);

      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
