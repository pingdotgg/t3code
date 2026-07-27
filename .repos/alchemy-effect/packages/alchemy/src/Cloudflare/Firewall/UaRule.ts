import * as firewall from "@distilled.cloud/cloudflare/firewall";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const UaRuleTypeId = "Cloudflare.Firewall.UaRule" as const;
type UaRuleTypeId = typeof UaRuleTypeId;

/**
 * The action a User Agent Blocking rule applies to a matched request.
 */
export type UaRuleMode =
  | "block"
  | "challenge"
  | "js_challenge"
  | "managed_challenge";

export interface UaRuleProps {
  /**
   * Zone the rule applies to.
   *
   * Stable — moving a rule between zones triggers a replacement.
   */
  zoneId: string;
  /**
   * The exact User-Agent string to match. The whole UA header must equal
   * this value — no wildcards or substring matching.
   *
   * Mutable — updated in place via PUT. Note that Cloudflare rejects a
   * second rule for the same User-Agent string in a zone, so the value
   * acts as the rule's identity for adoption.
   */
  userAgent: string;
  /**
   * The action to apply to a matched request. Mutable — updated in place.
   */
  mode: UaRuleMode;
  /**
   * An informative summary of the rule. Sanitized server-side (HTML tags
   * are removed). Mutable — updated in place.
   */
  description?: string;
  /**
   * When true, the rule is disabled without being deleted.
   * Mutable — updated in place.
   *
   * @default false
   */
  paused?: boolean;
}

export interface UaRuleAttributes {
  /** Cloudflare-assigned identifier of the User Agent Blocking rule. */
  uaRuleId: string;
  /** Zone the rule belongs to. */
  zoneId: string;
  /** The exact User-Agent string the rule matches. */
  userAgent: string;
  /** The action applied to matched requests. */
  mode: UaRuleMode;
  /** The rule's informative summary, if set. */
  description: string | undefined;
  /** Whether the rule is currently paused. */
  paused: boolean;
}

export type UaRule = Resource<
  UaRuleTypeId,
  UaRuleProps,
  UaRuleAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare User Agent Blocking rule — block or challenge every request
 * to a zone whose `User-Agent` header exactly matches a given string.
 *
 * Everything about a UA rule is mutable in place: `userAgent`, `mode`,
 * `description`, and `paused` are all updated via PUT without replacing the
 * rule. Only moving the rule to a different zone triggers a replacement.
 *
 * Cloudflare rejects a second rule for the same User-Agent string in a zone
 * with a duplicate error, so the UA string acts as a rule's identity. Plan
 * quotas: Free 10, Pro 50, Business 250, Enterprise 1000 rules.
 *
 * Safety: UA rules carry no ownership markers. When there is no prior
 * state, `read` scans the zone for an existing rule with the same
 * User-Agent string and reports it as `Unowned`, so the engine refuses to
 * take it over unless `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Firewall
 * @category Application Security
 * @section Blocking a User-Agent
 * @example Block a scraper outright
 * ```typescript
 * yield* Cloudflare.Firewall.UaRule("BlockScraper", {
 *   zoneId: zone.zoneId,
 *   userAgent: "BadBot/1.2 (+http://badbot.example)",
 *   mode: "block",
 *   description: "aggressive scraper",
 * });
 * ```
 *
 * @section Challenging a User-Agent
 * @example Managed challenge instead of a hard block
 * ```typescript
 * yield* Cloudflare.Firewall.UaRule("ChallengeOldClient", {
 *   zoneId: zone.zoneId,
 *   userAgent: "LegacyApp/0.9",
 *   mode: "managed_challenge",
 * });
 * ```
 *
 * @section Pausing a rule
 * @example Temporarily disable a rule without deleting it
 * ```typescript
 * yield* Cloudflare.Firewall.UaRule("BlockScraper", {
 *   zoneId: zone.zoneId,
 *   userAgent: "BadBot/1.2 (+http://badbot.example)",
 *   mode: "block",
 *   paused: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/waf/tools/user-agent-blocking/
 */
export const UaRule = Resource<UaRule>(UaRuleTypeId);

/**
 * Returns true if the given value is a UaRule resource.
 */
export const isUaRule = (value: unknown): value is UaRule =>
  Predicate.hasProperty(value, "Type") && value.Type === UaRuleTypeId;

export const UaRuleProvider = () =>
  Provider.succeed(UaRule, {
    stables: ["uaRuleId", "zoneId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // UA rules live inside a zone (`/zones/{zone_id}/firewall/ua_rules`)
      // with no account-wide list — enumerate every zone and exhaustively
      // paginate each one's rules.
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          firewall.listUaRules.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((rule) => toAttributes(rule, zone.id)),
              ),
            ),
            // Plan-gated / partial zones (eventually-consistent scoped
            // tokens) reject the route; skip them rather than fail the
            // whole enumeration.
            Effect.catchTag("Forbidden", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds = {}, news }) {
      const o = olds as UaRuleProps;
      const n = news as UaRuleProps;
      // No prior props to compare against — let the engine decide.
      if (o.zoneId === undefined) return undefined;
      // zoneId is Input<string>; compare only once both are concrete.
      if (
        typeof o.zoneId === "string" &&
        typeof n.zoneId === "string" &&
        o.zoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (zoneId === undefined) return undefined;

      // Owned path: refresh by our persisted rule id.
      if (output?.uaRuleId) {
        const observed = yield* getUaRule(zoneId, output.uaRuleId);
        if (observed) return toAttributes(observed, zoneId);
      }

      // Adoption path: a rule for this User-Agent string may already exist
      // (Cloudflare rejects duplicates, so the UA string is the rule's
      // identity within a zone). UA rules carry no ownership markers, so
      // brand a match `Unowned` and let the engine gate takeover behind
      // the adopt policy.
      const userAgent = output?.userAgent ?? olds?.userAgent;
      if (userAgent) {
        const observed = yield* findByUserAgent(zoneId, userAgent);
        if (observed) return Unowned(toAttributes(observed, zoneId));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the rule id cached on `output` is a hint, not a
      //    guarantee: a missing rule falls through to the User-Agent scan
      //    and then to create.
      let observed = output?.uaRuleId
        ? yield* getUaRule(zoneId, output.uaRuleId)
        : undefined;

      // 2. Fall back to scanning the zone for a User-Agent match.
      //    Ownership has already been verified upstream — `read` reports
      //    existing rules as `Unowned` and the engine gates takeover
      //    behind the adopt policy before reconcile ever runs.
      if (!observed) {
        observed = yield* findByUserAgent(zoneId, news.userAgent);
      }

      // 3. Ensure — create when missing. A concurrent create surfaces as
      //    `DuplicateUaRule` (Cloudflare code 10009): converge by
      //    re-scanning for the rule that won the race.
      if (!observed) {
        observed = yield* firewall
          .createUaRule({
            zoneId,
            configuration: { target: "ua", value: news.userAgent },
            mode: news.mode,
            description: news.description,
            paused: news.paused,
          })
          .pipe(
            Effect.catchTag("DuplicateUaRule", (error) =>
              findByUserAgent(zoneId, news.userAgent).pipe(
                Effect.flatMap((existing) =>
                  existing ? Effect.succeed(existing) : Effect.fail(error),
                ),
              ),
            ),
          );
      }

      // 4. Sync — diff observed cloud state against desired; skip the PUT
      //    entirely on a no-op. Undefined optional props are treated as
      //    "no constraint" so adoption doesn't clobber foreign settings.
      const dirty =
        (observed.configuration?.value ?? "") !== news.userAgent ||
        observed.mode !== news.mode ||
        (news.description !== undefined &&
          (observed.description ?? "") !== news.description) ||
        (news.paused !== undefined &&
          (observed.paused ?? false) !== news.paused);
      if (dirty) {
        observed = yield* firewall.updateUaRule({
          zoneId,
          uaRuleId: observed.id ?? "",
          configuration: { target: "ua", value: news.userAgent },
          mode: news.mode,
          description: news.description,
          paused: news.paused,
        });
      }

      return toAttributes(observed, zoneId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Cloudflare's DELETE is naturally idempotent (an already-gone rule
      // answers HTTP 200 echoing the id) — the typed catch covers the rare
      // not-found envelope race.
      yield* firewall
        .deleteUaRule({ zoneId: output.zoneId, uaRuleId: output.uaRuleId })
        .pipe(Effect.catchTag("UaRuleNotFound", () => Effect.void));
    }),
  });

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

type ObservedUaRule = firewall.GetUaRuleResponse;

/**
 * Read a UA rule by id, mapping "gone" (`UaRuleNotFound`, Cloudflare error
 * code 10001 `firewalluablock.api.not_found`) to `undefined`.
 */
const getUaRule = (zoneId: string, uaRuleId: string) =>
  firewall.getUaRule({ zoneId, uaRuleId }).pipe(
    Effect.map((rule): ObservedUaRule | undefined => rule),
    Effect.catchTag("UaRuleNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a rule by exact User-Agent string within the zone. The UA string is
 * a rule's identity — Cloudflare rejects duplicates — so at most one rule
 * can match.
 */
const findByUserAgent = (zoneId: string, userAgent: string) =>
  firewall.listUaRules.items({ zoneId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).find(
        (rule): rule is ObservedUaRule =>
          rule.configuration?.value === userAgent,
      ),
    ),
  );

const toAttributes = (
  rule: ObservedUaRule,
  zoneId: string,
): UaRuleAttributes => ({
  // Distilled types every field as optional/nullable — Cloudflare always
  // echoes them for a persisted rule.
  uaRuleId: rule.id ?? "",
  zoneId,
  userAgent: rule.configuration?.value ?? "",
  mode: (rule.mode ?? "block") as UaRuleMode,
  description: rule.description ?? undefined,
  paused: rule.paused ?? false,
});
