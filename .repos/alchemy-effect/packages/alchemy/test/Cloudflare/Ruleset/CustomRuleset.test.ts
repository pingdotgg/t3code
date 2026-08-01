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

const getRuleset = (accountId: string, rulesetId: string) =>
  rulesets.getRulesetForAccount({ accountId, rulesetId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
    Effect.catchTag("RulesetNotFound", () => Effect.succeed(undefined)),
  );

// Account-level custom rulesets require an Enterprise plan. On the standard
// testing account every create fails with the typed `PhaseNotEntitled` error
// (code 50002: "not entitled to use the phase http_request_firewall_custom").
// The test probes once: unentitled accounts assert the typed tag; entitled
// accounts run the full lifecycle.
test.provider(
  "custom ruleset lifecycle (typed PhaseNotEntitled on unentitled accounts)",
  (stack) =>
    Effect.gen(function* () {
      const accountId = yield* resolveAccountId;

      yield* stack.destroy();

      const probe = yield* rulesets
        .createRulesetForAccount({
          accountId,
          kind: "custom",
          name: "alchemy-customruleset-probe",
          phase,
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

      // Entitled — clean up the probe ruleset and run the full lifecycle.
      yield* rulesets
        .deleteRulesetForAccount({ accountId, rulesetId: probe.success.id })
        .pipe(Effect.catchTag("RulesetNotFound", () => Effect.void));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Ruleset.CustomRuleset("WafRules", {
            phase,
            description: "alchemy custom ruleset v1",
            rules: [
              {
                description: "Block exploit probes",
                expression: `lower(http.request.uri.path) contains "/.env"`,
                action: "block",
              },
            ],
          });
        }),
      );
      expect(created.accountId).toEqual(accountId);
      expect(created.kind).toEqual("custom");
      expect(created.phase).toEqual(phase);
      expect(created.rules).toHaveLength(1);

      // Out-of-band verification via the distilled API.
      const live = yield* getRuleset(accountId, created.rulesetId);
      expect(live?.description).toEqual("alchemy custom ruleset v1");
      expect(live?.rules?.[0]).toMatchObject({
        action: "block",
        expression: `lower(http.request.uri.path) contains "/.env"`,
      });

      // Update rules + description in place — same physical ruleset.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Ruleset.CustomRuleset("WafRules", {
            phase,
            description: "alchemy custom ruleset v2",
            rules: [
              {
                description: "Challenge exploit probes",
                expression: `lower(http.request.uri.path) contains "/.env"`,
                action: "managed_challenge",
              },
            ],
          });
        }),
      );
      expect(updated.rulesetId).toEqual(created.rulesetId);
      expect(updated.description).toEqual("alchemy custom ruleset v2");
      expect(updated.rules[0]?.action).toEqual("managed_challenge");

      const patched = yield* getRuleset(accountId, created.rulesetId);
      expect(patched?.rules?.[0]?.action).toEqual("managed_challenge");

      // Destroy and verify the ruleset is gone (typed not-found read).
      yield* stack.destroy();
      const gone = yield* getRuleset(accountId, created.rulesetId);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (account-scoped collection). `list()` enumerates the
// account's rulesets, filters to `kind: custom`, and hydrates each into the
// full `read` Attributes shape. Account-level custom WAF phases require an
// Enterprise plan: unentitled accounts (the standard testing account) fail the
// create with the typed `PhaseNotEntitled` error, so we still verify `list()`
// returns an array without throwing; entitled accounts additionally deploy a
// ruleset and assert it appears in the exhaustively-paginated result.
test.provider(
  "list enumerates the deployed custom ruleset",
  (stack) =>
    Effect.gen(function* () {
      const accountId = yield* resolveAccountId;

      yield* stack.destroy();

      const probe = yield* rulesets
        .createRulesetForAccount({
          accountId,
          kind: "custom",
          name: "alchemy-customruleset-list-probe",
          phase,
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
        // Unentitled — assert the typed entitlement tag, then verify the
        // provider's `list()` still enumerates without error (returns []).
        expect(probe.failure._tag).toEqual("PhaseNotEntitled");
        const provider = yield* Provider.findProvider(
          Cloudflare.Ruleset.CustomRuleset,
        );
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
        yield* stack.destroy();
        return;
      }

      // Entitled — clean up the probe and run the full list assertion.
      yield* rulesets
        .deleteRulesetForAccount({ accountId, rulesetId: probe.success.id })
        .pipe(Effect.catchTag("RulesetNotFound", () => Effect.void));

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Ruleset.CustomRuleset("ListWafRules", {
            phase,
            description: "alchemy custom ruleset list",
            rules: [
              {
                description: "Block exploit probes",
                expression: `lower(http.request.uri.path) contains "/.env"`,
                action: "block",
              },
            ],
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Ruleset.CustomRuleset,
      );
      const all = yield* provider.list();

      expect(all.some((r) => r.rulesetId === deployed.rulesetId)).toBe(true);
      const found = all.find((r) => r.rulesetId === deployed.rulesetId);
      expect(found?.kind).toEqual("custom");
      expect(found?.rules).toHaveLength(1);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
