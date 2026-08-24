import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { poll } from "@/Util/poll";
import * as snippets from "@distilled.cloud/cloudflare/snippets";
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

// Deterministic snippet names — same value on every run.
const NAME_RULES_A = "alchemy_snippet_rules_a";
const NAME_RULES_B = "alchemy_snippet_rules_b";

const EXPRESSION_V1 = 'http.request.uri.path wildcard "/alchemy-snippet/*"';
const EXPRESSION_V2 = 'http.request.uri.path wildcard "/alchemy-snippet-v2/*"';
const EXPRESSION_B = 'http.request.uri.path wildcard "/alchemy-snippet-b/*"';

const code = `
export default {
  async fetch(request) {
    const response = await fetch(request);
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("x-alchemy-snippet", "rules-test");
    return newResponse;
  },
};
`;

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

interface WireRule {
  readonly snippet_name?: string;
  readonly expression?: string;
  readonly enabled?: boolean;
  readonly description?: string | null;
}

// Ride out eventually-consistent 403s (freshly-minted scoped tokens
// propagate slowly across Cloudflare's edge) on the test's own
// out-of-band verification calls.
const forbiddenRetryPolicy = {
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

const listLiveRules = (zoneId: string) =>
  snippets.listRules({ zoneId }).pipe(
    Effect.map((result) =>
      Array.isArray(result) ? (result as WireRule[]) : [],
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      ...forbiddenRetryPolicy,
    }),
  );

// The live rule list is eventually consistent after a PUT — poll the
// out-of-band read until it reaches the expected length before asserting.
const pollLiveRules = (zoneId: string, expectedLength: number) =>
  poll({
    description: `snippet rules length === ${expectedLength}`,
    effect: listLiveRules(zoneId),
    predicate: (rules) => rules.length === expectedLength,
    schedule: Schedule.max([
      Schedule.exponential("500 millis"),
      Schedule.recurs(10),
    ]),
  });

const findSnippet = (zoneId: string, name: string) =>
  snippets.listSnippets({ zoneId, perPage: 100 }).pipe(
    Effect.map((page) =>
      (page.result ?? []).find((s) => s.snippetName === name),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      ...forbiddenRetryPolicy,
    }),
  );

// The zone's snippet-rule list is a singleton; purge any leftovers from
// interrupted runs so the test starts from a clean slate.
const purgeRules = (zoneId: string) =>
  snippets.deleteRule({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      ...forbiddenRetryPolicy,
    }),
    Effect.catchTag("SnippetRulesNotFound", () => Effect.void),
  );

// The zone's snippet-rule list is a per-zone SINGLETON, and snippets are
// keyed by name within a zone. There is only one standing test zone, so two
// `test.provider` cases (which run CONCURRENTLY within a file) would fight
// over the same singleton rule list and the same snippet name — one case's
// `purgeRules`/`destroy` empties the other's freshly-PUT rule list, and one
// case's snippet delete races the other's rule that still references it
// (`snippet is still used`). They are therefore folded into ONE sequential
// case: create/update/destroy lifecycle PLUS the `list()` enumeration.
test.provider(
  "snippet rules — create, update, list, and destroy in dependency order",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* purgeRules(zoneId);

      // Create a snippet plus one rule activating it.
      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          const snippet = yield* Cloudflare.Snippets.Snippet("RulesSnippetA", {
            zoneId,
            name: NAME_RULES_A,
            code,
          }).pipe(adopt(true));
          const rules = yield* Cloudflare.Snippets.SnippetRules("Rules", {
            zoneId,
            rules: [
              {
                snippetName: snippet.name,
                expression: EXPRESSION_V1,
                description: "alchemy snippet rules test",
              },
            ],
          }).pipe(adopt(true));
          return { snippet, rules };
        }),
      );

      expect(initial.rules.zoneId).toEqual(zoneId);
      expect(initial.rules.rules).toHaveLength(1);
      expect(initial.rules.rules[0].snippetName).toEqual(NAME_RULES_A);
      expect(initial.rules.rules[0].expression).toEqual(EXPRESSION_V1);
      expect(initial.rules.rules[0].enabled).toEqual(true);

      const live = yield* pollLiveRules(zoneId, 1);
      expect(live).toHaveLength(1);
      expect(live[0].snippet_name).toEqual(NAME_RULES_A);
      expect(live[0].expression).toEqual(EXPRESSION_V1);

      // `list()` enumerates every zone (no account-wide rule-list API) and
      // reads the rule list in each, skipping zones with no rules / no
      // access. Our deployed rule list must surface for the test zone.
      const provider = yield* Provider.findProvider(
        Cloudflare.Snippets.SnippetRules,
      );
      const all = yield* provider.list();
      expect(all.length).toBeGreaterThan(0);
      const entry = all.find((r) => r.zoneId === zoneId);
      expect(entry).toBeDefined();
      expect(entry!.rules.some((r) => r.snippetName === NAME_RULES_A)).toBe(
        true,
      );

      // Update: change the expression and add a second snippet + rule.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const snippetA = yield* Cloudflare.Snippets.Snippet("RulesSnippetA", {
            zoneId,
            name: NAME_RULES_A,
            code,
          }).pipe(adopt(true));
          const snippetB = yield* Cloudflare.Snippets.Snippet("RulesSnippetB", {
            zoneId,
            name: NAME_RULES_B,
            code,
          }).pipe(adopt(true));
          const rules = yield* Cloudflare.Snippets.SnippetRules("Rules", {
            zoneId,
            rules: [
              {
                snippetName: snippetA.name,
                expression: EXPRESSION_V2,
                description: "alchemy snippet rules test v2",
              },
              {
                snippetName: snippetB.name,
                expression: EXPRESSION_B,
                enabled: false,
              },
            ],
          }).pipe(adopt(true));
          return { rules };
        }),
      );

      expect(updated.rules.rules).toHaveLength(2);
      expect(updated.rules.rules[0].expression).toEqual(EXPRESSION_V2);
      expect(updated.rules.rules[1].snippetName).toEqual(NAME_RULES_B);
      expect(updated.rules.rules[1].enabled).toEqual(false);

      const liveUpdated = yield* pollLiveRules(zoneId, 2);
      expect(liveUpdated).toHaveLength(2);
      expect(liveUpdated[0].expression).toEqual(EXPRESSION_V2);
      expect(liveUpdated[1].snippet_name).toEqual(NAME_RULES_B);

      // Destroy — rules must be deleted before the snippets they
      // reference (dependency ordering via the `snippetName` input). The
      // snippet delete bounded-retries the typed `SnippetInUse` lag.
      yield* stack.destroy();

      const liveGone = yield* pollLiveRules(zoneId, 0);
      expect(liveGone).toHaveLength(0);
      expect(yield* findSnippet(zoneId, NAME_RULES_A)).toBeUndefined();
      expect(yield* findSnippet(zoneId, NAME_RULES_B)).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
