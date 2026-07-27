import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const phase = "http_request_firewall_custom";

const resolveAccountId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return accountId;
});

const getEntrypointRules = (accountId: string) =>
  rulesets.getPhasForAccount({ accountId, rulesetPhase: phase }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
    Effect.map((entrypoint) => entrypoint.rules ?? []),
    Effect.catchTag("RulesetNotFound", () => Effect.succeed([])),
  );

// Account-level phase entrypoints require an Enterprise plan. On the
// standard testing account every PUT fails with the typed `PhaseNotEntitled`
// error (code 50002). The test probes once: unentitled accounts assert the
// typed tag; entitled accounts run the full lifecycle.
test.provider(
  "account entrypoint lifecycle (typed PhaseNotEntitled on unentitled accounts)",
  (stack) =>
    Effect.gen(function* () {
      const accountId = yield* resolveAccountId;

      yield* stack.destroy();

      // Probing with an empty rules PUT is a harmless baseline on entitled
      // accounts (the entrypoint is a singleton; empty = "no rules").
      const probe = yield* rulesets
        .putPhasForAccount({
          accountId,
          rulesetPhase: phase,
          rules: [],
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.result,
        );

      if (Result.isFailure(probe)) {
        // Unentitled — the distilled call must fail with the typed
        // entitlement tag, never an untyped catch-all.
        expect(probe.failure._tag).toEqual("PhaseNotEntitled");
        yield* stack.destroy();
        return;
      }

      // Entitled — deploy a custom ruleset plus the entrypoint that
      // executes it (the Enterprise WAF deployment workflow).
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleset = yield* Cloudflare.Ruleset.CustomRuleset(
            "SharedRules",
            {
              phase,
              rules: [
                {
                  description: "Block exploit probes",
                  expression: `lower(http.request.uri.path) contains "/.env"`,
                  action: "block",
                },
              ],
            },
          );
          const entrypoint = yield* Cloudflare.Ruleset.AccountEntrypoint(
            "WafDeployment",
            {
              phase,
              description: "alchemy account entrypoint v1",
              rules: [
                {
                  description: "Deploy shared WAF rules",
                  expression: "true",
                  action: "execute",
                  actionParameters: { id: ruleset.rulesetId },
                },
              ],
            },
          );
          return { entrypoint, ruleset };
        }),
      );
      expect(deployed.entrypoint.accountId).toEqual(accountId);
      expect(deployed.entrypoint.phase).toEqual(phase);
      expect(deployed.entrypoint.rules).toHaveLength(1);

      // Out-of-band verification via the distilled API.
      const liveRules = yield* getEntrypointRules(accountId);
      expect(liveRules).toHaveLength(1);
      expect(liveRules[0]).toMatchObject({ action: "execute" });

      // Update the description in place — same singleton entrypoint.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleset = yield* Cloudflare.Ruleset.CustomRuleset(
            "SharedRules",
            {
              phase,
              rules: [
                {
                  description: "Block exploit probes",
                  expression: `lower(http.request.uri.path) contains "/.env"`,
                  action: "block",
                },
              ],
            },
          );
          return yield* Cloudflare.Ruleset.AccountEntrypoint("WafDeployment", {
            phase,
            description: "alchemy account entrypoint v2",
            rules: [
              {
                description: "Deploy shared WAF rules",
                expression: "true",
                action: "execute",
                actionParameters: { id: ruleset.rulesetId },
              },
            ],
          });
        }),
      );
      expect(updated.rulesetId).toEqual(deployed.entrypoint.rulesetId);
      expect(updated.description).toEqual("alchemy account entrypoint v2");

      // Destroy and verify the entrypoint was emptied in Cloudflare.
      yield* stack.destroy();
      const remaining = yield* getEntrypointRules(accountId);
      expect(remaining).toEqual([]);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the account phase entrypoints",
  (stack) =>
    Effect.gen(function* () {
      const accountId = yield* resolveAccountId;

      yield* stack.destroy();

      // Probe entitlement: an empty-rules PUT is a harmless baseline on
      // entitled accounts, but fails with the typed `PhaseNotEntitled` tag
      // on the standard testing account.
      const probe = yield* rulesets
        .putPhasForAccount({ accountId, rulesetPhase: phase, rules: [] })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.result,
        );

      const provider = yield* Provider.findProvider(
        Cloudflare.Ruleset.AccountEntrypoint,
      );

      if (Result.isFailure(probe)) {
        // Unentitled — list must still succeed (typed-skip gated phases) and
        // return a well-typed array rather than throwing.
        expect(probe.failure._tag).toEqual("PhaseNotEntitled");
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
        yield* stack.destroy();
        return;
      }

      // Entitled — deploy the entrypoint and assert list() surfaces it in the
      // exhaustively-enumerated result.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleset = yield* Cloudflare.Ruleset.CustomRuleset(
            "SharedRules",
            {
              phase,
              rules: [
                {
                  description: "Block exploit probes",
                  expression: `lower(http.request.uri.path) contains "/.env"`,
                  action: "block",
                },
              ],
            },
          );
          return yield* Cloudflare.Ruleset.AccountEntrypoint("WafDeployment", {
            phase,
            description: "alchemy account entrypoint list",
            rules: [
              {
                description: "Deploy shared WAF rules",
                expression: "true",
                action: "execute",
                actionParameters: { id: ruleset.rulesetId },
              },
            ],
          });
        }),
      );

      const all = yield* provider.list();
      expect(all.some((e) => e.rulesetId === deployed.rulesetId)).toBe(true);
      const found = all.find((e) => e.rulesetId === deployed.rulesetId)!;
      expect(found.accountId).toEqual(accountId);
      expect(found.phase).toEqual(phase);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
