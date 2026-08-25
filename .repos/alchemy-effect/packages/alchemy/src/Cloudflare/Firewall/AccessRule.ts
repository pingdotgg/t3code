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

const FirewallAccessRuleTypeId = "Cloudflare.Firewall.AccessRule" as const;
type FirewallAccessRuleTypeId = typeof FirewallAccessRuleTypeId;

/**
 * The action an IP Access rule applies to a matched request.
 *
 * Note: `block` for `country`/`asn` targets requires an Enterprise plan;
 * `challenge` and `managed_challenge` work on all plans.
 */
export type AccessRuleMode =
  | "block"
  | "challenge"
  | "whitelist"
  | "js_challenge"
  | "managed_challenge";

/**
 * What a rule's configuration matches on: a single IPv4 (`ip`), a single
 * IPv6 (`ip6`), a CIDR range (`ip_range`), an AS number (`asn`), or a
 * two-letter ISO-3166-1 alpha-2 country code (`country`).
 */
export type AccessRuleTarget = "ip" | "ip6" | "ip_range" | "asn" | "country";

/**
 * The match configuration of an IP Access rule. Immutable — the Cloudflare
 * API only allows `mode`/`notes` to be patched, so changing the
 * configuration replaces the rule.
 */
export interface AccessRuleConfiguration {
  /**
   * What the rule matches on.
   */
  target: AccessRuleTarget;
  /**
   * The value to match — e.g. `198.51.100.4` (`ip`), `2001:db8::/64`
   * (`ip_range`), `AS13335` (`asn`), or `US` (`country`).
   */
  value: string;
}

export interface AccessRuleProps {
  /**
   * Zone the rule applies to. When omitted, the rule is created at the
   * account level and applies to every zone in the account.
   *
   * Stable — moving a rule between scopes triggers a replacement.
   */
  zoneId?: string;
  /**
   * The rule's match configuration (target + value).
   *
   * Immutable — the API has no way to change a rule's configuration
   * (only `mode`/`notes` are patchable), so changing it triggers a
   * replacement.
   */
  configuration: AccessRuleConfiguration;
  /**
   * The action to apply to a matched request. Mutable — patched in place.
   */
  mode: AccessRuleMode;
  /**
   * An informative summary of the rule, typically used as a reminder or
   * explanation. Mutable — patched in place.
   */
  notes?: string;
}

export interface AccessRuleAttributes {
  /** Cloudflare-assigned identifier of the IP Access rule. */
  ruleId: string;
  /** Zone the rule belongs to, or `undefined` for account-scoped rules. */
  zoneId: string | undefined;
  /** Account the rule was created under. */
  accountId: string;
  /** The rule's match configuration. */
  configuration: AccessRuleConfiguration;
  /** The action applied to matched requests. */
  mode: AccessRuleMode;
  /** The actions available for this rule. */
  allowedModes: AccessRuleMode[];
  /** The rule's informative summary, if set. */
  notes: string | undefined;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type AccessRule = Resource<
  FirewallAccessRuleTypeId,
  AccessRuleProps,
  AccessRuleAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare IP Access rule — block, challenge, or whitelist requests by
 * IP, CIDR range, ASN, or country, either on a single zone or across the
 * whole account.
 *
 * A rule's identity is its `configuration` (target + value) within a scope:
 * Cloudflare rejects a second rule for the same configuration with a
 * duplicate error, and the configuration cannot be changed after creation —
 * only `mode` and `notes` are mutable. Changing `configuration` or moving
 * the rule between zone and account scope triggers a replacement.
 *
 * Safety: IP Access rules carry no ownership markers. When there is no
 * prior state, `read` scans the scope for an existing rule with the same
 * configuration and reports it as `Unowned`, so the engine refuses to take
 * it over unless `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Firewall
 * @category Application Security
 * @section Blocking an IP
 * @example Block a single IPv4 address on a zone
 * ```typescript
 * yield* Cloudflare.Firewall.AccessRule("BlockBadActor", {
 *   zoneId: zone.zoneId,
 *   configuration: { target: "ip", value: "198.51.100.4" },
 *   mode: "block",
 *   notes: "repeated credential stuffing",
 * });
 * ```
 *
 * @example Block a CIDR range account-wide
 * ```typescript
 * // No zoneId — the rule applies to every zone in the account.
 * yield* Cloudflare.Firewall.AccessRule("BlockScannerRange", {
 *   configuration: { target: "ip_range", value: "203.0.113.0/24" },
 *   mode: "block",
 * });
 * ```
 *
 * @section Challenging traffic
 * @example Managed challenge for a country
 * ```typescript
 * // `block` for country targets is Enterprise-only; challenges work on
 * // all plans.
 * yield* Cloudflare.Firewall.AccessRule("ChallengeCountry", {
 *   zoneId: zone.zoneId,
 *   configuration: { target: "country", value: "KP" },
 *   mode: "managed_challenge",
 * });
 * ```
 *
 * @section Whitelisting
 * @example Always allow an office IP
 * ```typescript
 * yield* Cloudflare.Firewall.AccessRule("AllowOffice", {
 *   zoneId: zone.zoneId,
 *   configuration: { target: "ip", value: "192.0.2.10" },
 *   mode: "whitelist",
 *   notes: "office egress IP",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/waf/tools/ip-access-rules/
 */
export const AccessRule = Resource<AccessRule>(FirewallAccessRuleTypeId);

/**
 * Returns true if the given value is a AccessRule resource.
 */
export const isAccessRule = (value: unknown): value is AccessRule =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === FirewallAccessRuleTypeId;

export const AccessRuleProvider = () =>
  Provider.succeed(AccessRule, {
    stables: ["ruleId", "zoneId", "accountId", "allowedModes", "createdOn"],

    diff: Effect.fn(function* ({ olds = {}, news }) {
      const o = olds as AccessRuleProps;
      const n = news as AccessRuleProps;
      // No prior props to compare against — let the engine decide.
      if (o.configuration === undefined) return undefined;
      // The API can only patch mode/notes — configuration is immutable.
      if (
        o.configuration.target !== n.configuration.target ||
        o.configuration.value !== n.configuration.value
      ) {
        return { action: "replace" } as const;
      }
      // Scope change (zone <-> account, or a different zone) replaces.
      if ((o.zoneId === undefined) !== (n.zoneId === undefined)) {
        return { action: "replace" } as const;
      }
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
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by our persisted rule id.
      if (output?.ruleId) {
        const observed = yield* getRule(zoneId, acct, output.ruleId);
        if (observed) return toAttributes(observed, zoneId, acct);
      }

      // Adoption path: a rule with this configuration may already exist in
      // the scope. Access rules carry no ownership markers, so we cannot
      // prove we created it — brand it `Unowned` so the engine refuses to
      // take over unless `adopt` is set.
      const configuration = output?.configuration ?? olds?.configuration;
      if (configuration) {
        const observed = yield* findByConfiguration(
          zoneId,
          acct,
          configuration,
        );
        if (observed) return Unowned(toAttributes(observed, zoneId, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string | undefined;

      // 1. Observe — the rule id cached on `output` is a hint, not a
      //    guarantee: a missing rule falls through to the configuration
      //    scan and then to create.
      let observed = output?.ruleId
        ? yield* getRule(zoneId, accountId, output.ruleId)
        : undefined;

      // 2. Fall back to scanning the scope for a configuration match.
      //    Ownership has already been verified upstream — `read` reports
      //    existing rules as `Unowned` and the engine gates takeover
      //    behind the adopt policy before reconcile ever runs.
      if (!observed) {
        observed = yield* findByConfiguration(
          zoneId,
          accountId,
          news.configuration,
        );
      }

      // 3. Ensure — create when missing. A concurrent create surfaces as
      //    `DuplicateAccessRule` (Cloudflare code 10009): converge by
      //    re-scanning for the rule that won the race.
      if (!observed) {
        observed = yield* createRule(zoneId, accountId, news).pipe(
          Effect.catchTag("DuplicateAccessRule", (error) =>
            findByConfiguration(zoneId, accountId, news.configuration).pipe(
              Effect.flatMap((existing) =>
                existing ? Effect.succeed(existing) : Effect.fail(error),
              ),
            ),
          ),
        );
      }

      // 4. Sync — diff observed mode/notes against desired; skip the
      //    patch call entirely on a no-op.
      const dirty =
        observed.mode !== news.mode ||
        (news.notes !== undefined && (observed.notes ?? "") !== news.notes);
      if (dirty) {
        observed = yield* patchRule(zoneId, accountId, observed.id, news);
      }

      return toAttributes(observed, zoneId, accountId);
    }),

    // IP Access rules are hybrid-scoped: account-level rules (zoneId
    // undefined) plus per-zone rules. Enumerate both — the account
    // collection, then fan out across every zone — and tag each item with
    // its scope so the result matches the exact `read` Attributes shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const accountRules = yield* firewall.listAccessRulesForAccount
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((rule) =>
                toAttributes(rule, undefined, accountId),
              ),
            ),
          ),
          // No permission to read account-level rules — skip them.
          Effect.catchTag("Forbidden", () => Effect.succeed([])),
        );

      const zones = yield* listAllZones(accountId);
      const zoneRuleGroups = yield* Effect.forEach(
        zones,
        (zone) =>
          firewall.listAccessRulesForZone.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((rule) =>
                  toAttributes(rule, zone.id, accountId),
                ),
              ),
            ),
            // Plan-gated / partial zones reject the route; skip them.
            Effect.catchTag("Forbidden", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );

      return [...accountRules, ...zoneRuleGroups.flat()];
    }),

    delete: Effect.fn(function* ({ output }) {
      // Cloudflare answers DELETE for an already-gone rule with HTTP 200
      // and `result: null` (not an error envelope), which the typed
      // response decode rejects — observe first and treat missing as done.
      const observed = yield* getRule(
        output.zoneId,
        output.accountId,
        output.ruleId,
      );
      if (!observed) return;
      yield* deleteRule(output.zoneId, output.accountId, output.ruleId).pipe(
        Effect.catchTag("AccessRuleNotFound", () => Effect.void),
      );
    }),
  });

// ---------------------------------------------------------------------------
// Scoped API helpers (zone-level when zoneId is set, account-level otherwise)
// ---------------------------------------------------------------------------

type ObservedRule = firewall.GetAccessRuleResponse;

/**
 * Read a rule by id, mapping "gone" (`AccessRuleNotFound`, Cloudflare error
 * code 10001 `firewallaccessrules.api.not_found`) to `undefined`.
 */
const getRule = (
  zoneId: string | undefined,
  accountId: string,
  ruleId: string,
) =>
  (zoneId !== undefined
    ? firewall.getAccessRuleForZone({ zoneId, ruleId })
    : firewall.getAccessRuleForAccount({ accountId, ruleId })
  ).pipe(
    Effect.map((rule): ObservedRule | undefined => rule),
    Effect.catchTag("AccessRuleNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a rule by exact configuration (target + value) within the scope.
 * The configuration is a rule's identity — Cloudflare rejects duplicates —
 * so at most one rule can match.
 */
const findByConfiguration = (
  zoneId: string | undefined,
  accountId: string,
  configuration: AccessRuleConfiguration,
) =>
  (zoneId !== undefined
    ? firewall.listAccessRulesForZone.items({ zoneId })
    : firewall.listAccessRulesForAccount.items({ accountId })
  ).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).find(
        (rule): rule is ObservedRule =>
          rule.configuration.target === configuration.target &&
          rule.configuration.value === configuration.value,
      ),
    ),
  );

const createRule = (
  zoneId: string | undefined,
  accountId: string,
  news: AccessRuleProps,
) =>
  zoneId !== undefined
    ? firewall.createAccessRuleForZone({
        zoneId,
        configuration: news.configuration,
        mode: news.mode,
        notes: news.notes,
      })
    : firewall.createAccessRuleForAccount({
        accountId,
        configuration: news.configuration,
        mode: news.mode,
        notes: news.notes,
      });

const patchRule = (
  zoneId: string | undefined,
  accountId: string,
  ruleId: string,
  news: AccessRuleProps,
) =>
  zoneId !== undefined
    ? firewall.patchAccessRuleForZone({
        zoneId,
        ruleId,
        configuration: news.configuration,
        mode: news.mode,
        notes: news.notes,
      })
    : firewall.patchAccessRuleForAccount({
        accountId,
        ruleId,
        configuration: news.configuration,
        mode: news.mode,
        notes: news.notes,
      });

const deleteRule = (
  zoneId: string | undefined,
  accountId: string,
  ruleId: string,
) =>
  zoneId !== undefined
    ? firewall.deleteAccessRuleForZone({ zoneId, ruleId })
    : firewall.deleteAccessRuleForAccount({ accountId, ruleId });

const toAttributes = (
  rule: ObservedRule,
  zoneId: string | undefined,
  accountId: string,
): AccessRuleAttributes => ({
  ruleId: rule.id,
  zoneId,
  accountId,
  configuration: {
    // Distilled types each union variant's target/value as optional —
    // Cloudflare always echoes both for a persisted rule.
    target: (rule.configuration.target ?? "ip") as AccessRuleTarget,
    value: rule.configuration.value ?? "",
  },
  mode: rule.mode as AccessRuleMode,
  allowedModes: [...rule.allowedModes] as AccessRuleMode[],
  notes: rule.notes ?? undefined,
  createdOn: rule.createdOn ?? undefined,
  modifiedOn: rule.modifiedOn ?? undefined,
});
