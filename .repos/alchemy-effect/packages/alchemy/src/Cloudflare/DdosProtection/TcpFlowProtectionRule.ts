import * as ddos from "@distilled.cloud/cloudflare/ddos-protection";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.DdosProtection.TcpFlowProtectionRule" as const;
type TypeId = typeof TypeId;

/**
 * Operating mode of a TCP Flow Protection rule: actively mitigate
 * (`enabled`), observe only (`monitoring`), or stand down (`disabled`).
 */
export type TcpFlowProtectionRuleMode = "enabled" | "disabled" | "monitoring";

/**
 * Where a TCP Flow Protection rule applies: every prefix (`global`), one
 * Cloudflare region (`region`), or one data center (`datacenter`).
 */
export type TcpFlowProtectionRuleScope = "global" | "region" | "datacenter";

/**
 * Sensitivity of the TCP Flow Protection thresholds.
 */
export type TcpFlowProtectionRuleSensitivity = "low" | "medium" | "high";

export interface TcpFlowProtectionRuleProps {
  /**
   * The scope of the rule: `global`, `region`, or `datacenter`.
   *
   * Immutable — the API only patches mode/sensitivities, so changing the
   * scope triggers a replacement.
   */
  scope: TcpFlowProtectionRuleScope;
  /**
   * The name of the rule, relative to `scope`: for `global` scope the name
   * is `global`; for `region`/`datacenter` scope it is the region or data
   * center name (e.g. `WEUR`, `SJC`).
   *
   * Immutable — changing the name triggers a replacement.
   * @default "global"
   */
  name?: string;
  /**
   * Operating mode of the rule. Mutable — patched in place.
   */
  mode: TcpFlowProtectionRuleMode;
  /**
   * The burst sensitivity. Mutable — patched in place.
   */
  burstSensitivity: TcpFlowProtectionRuleSensitivity;
  /**
   * The rate sensitivity. Mutable — patched in place.
   */
  rateSensitivity: TcpFlowProtectionRuleSensitivity;
}

export interface TcpFlowProtectionRuleAttributes {
  /** Cloudflare-assigned identifier of the TCP Flow Protection rule. */
  ruleId: string;
  /** The Cloudflare account the rule belongs to. */
  accountId: string;
  /** The scope of the rule. */
  scope: TcpFlowProtectionRuleScope;
  /** The name of the rule, relative to its scope. */
  name: string;
  /** Operating mode of the rule. */
  mode: TcpFlowProtectionRuleMode;
  /** The burst sensitivity. */
  burstSensitivity: TcpFlowProtectionRuleSensitivity;
  /** The rate sensitivity. */
  rateSensitivity: TcpFlowProtectionRuleSensitivity;
  /** ISO8601 creation timestamp. */
  createdOn: string;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string;
}

export type TcpFlowProtectionRule = Resource<
  TypeId,
  TcpFlowProtectionRuleProps,
  TcpFlowProtectionRuleAttributes,
  never,
  Providers
>;

/**
 * An Advanced TCP Protection out-of-state TCP flow rule (Magic Transit).
 *
 * Rules tune how Cloudflare mitigates out-of-state TCP packet floods (ACK,
 * RST, …) on Magic Transit prefixes, per scope (`global`, a region, or a
 * data center). The rule's identity is its `scope` + `name` pair — only
 * `mode` and the sensitivities are mutable in place.
 *
 * Requires the **Magic Transit / Advanced TCP Protection** entitlement; on
 * accounts without it every API call fails with the typed
 * `AdvancedTcpProtectionNotEntitled` error.
 *
 * Safety: rules carry no ownership markers. When there is no prior state,
 * `read` scans for an existing rule with the same scope + name and reports
 * it as `Unowned`, so the engine refuses to take it over unless `--adopt`
 * (or `adopt(true)`) is set.
 * @resource
 * @product DDoS Protection
 * @category Network
 * @section Creating a rule
 * @example Global TCP flow protection in monitoring mode
 * ```typescript
 * const rule = yield* Cloudflare.DdosProtection.TcpFlowProtectionRule("GlobalFlow", {
 *   scope: "global",
 *   mode: "monitoring",
 *   burstSensitivity: "medium",
 *   rateSensitivity: "medium",
 * });
 * ```
 *
 * @example Region-scoped rule
 * ```typescript
 * yield* Cloudflare.DdosProtection.TcpFlowProtectionRule("WeurFlow", {
 *   scope: "region",
 *   name: "WEUR",
 *   mode: "enabled",
 *   burstSensitivity: "high",
 *   rateSensitivity: "low",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ddos-protection/advanced-ddos-systems/overview/advanced-tcp-protection/
 */
export const TcpFlowProtectionRule = Resource<TcpFlowProtectionRule>(TypeId);

/**
 * Returns true if the given value is a TcpFlowProtectionRule resource.
 */
export const isTcpFlowProtectionRule = (
  value: unknown,
): value is TcpFlowProtectionRule =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const TcpFlowProtectionRuleProvider = () =>
  Provider.succeed(TcpFlowProtectionRule, {
    stables: ["ruleId", "accountId", "scope", "name", "createdOn"],

    diff: Effect.fn(function* ({ olds, news }) {
      if (olds === undefined) return undefined;
      // `news` runs at plan time and may still carry unresolved
      // expressions — bail out and let the engine apply default logic.
      if (!isResolved(news)) return undefined;
      // The API only patches mode/sensitivities — the scope + name pair is
      // the rule's identity and cannot change.
      if (olds.scope !== news.scope || ruleName(olds) !== ruleName(news)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* ddos.listAdvancedTcpProtectionTcpFlowProtectionRules
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((rule) => toAttributes(rule, accountId)),
            ),
          ),
          // Accounts lacking the Advanced TCP Protection entitlement (or a
          // token without access) can't enumerate rules — there is nothing
          // to nuke, so report an empty set rather than failing.
          Effect.catchTags({
            AdvancedTcpProtectionNotEntitled: () =>
              Effect.succeed<TcpFlowProtectionRuleAttributes[]>([]),
            Forbidden: () =>
              Effect.succeed<TcpFlowProtectionRuleAttributes[]>([]),
          }),
        );
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by our persisted rule id.
      if (output?.ruleId) {
        const observed = yield* getRule(acct, output.ruleId);
        if (observed) return toAttributes(observed, acct);
      }

      // Adoption path: a rule for this scope + name may already exist.
      // Rules carry no ownership markers, so brand the match `Unowned` —
      // the engine refuses to take over unless `adopt` is set.
      const identity = output ?? olds;
      if (identity?.scope) {
        const observed = yield* findByScopeAndName(
          acct,
          identity.scope,
          ruleName(identity),
        );
        if (observed) return Unowned(toAttributes(observed, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = ruleName(news);

      // 1. Observe — the rule id cached on `output` is a hint, not a
      //    guarantee: a missing rule falls through to the scope + name
      //    scan and then to create.
      let observed = output?.ruleId
        ? yield* getRule(accountId, output.ruleId)
        : undefined;

      // 2. Fall back to scanning for the scope + name match (ownership was
      //    already gated by `read` reporting existing rules as Unowned).
      if (!observed) {
        observed = yield* findByScopeAndName(accountId, news.scope, name);
      }

      // 3. Ensure — create when missing.
      if (!observed) {
        observed = yield* ddos.createAdvancedTcpProtectionTcpFlowProtectionRule(
          {
            accountId,
            scope: news.scope,
            name,
            mode: news.mode,
            burstSensitivity: news.burstSensitivity,
            rateSensitivity: news.rateSensitivity,
          },
        );
      }

      // 4. Sync — diff observed mutable aspects against desired; skip the
      //    patch entirely on a no-op.
      const dirty =
        observed.mode !== news.mode ||
        observed.burstSensitivity !== news.burstSensitivity ||
        observed.rateSensitivity !== news.rateSensitivity;
      if (dirty) {
        observed =
          yield* ddos.patchAdvancedTcpProtectionTcpFlowProtectionRuleItem({
            accountId,
            ruleId: observed.id,
            mode: news.mode,
            burstSensitivity: news.burstSensitivity,
            rateSensitivity: news.rateSensitivity,
          });
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ddos
        .deleteAdvancedTcpProtectionTcpFlowProtectionRuleItem({
          accountId: output.accountId,
          ruleId: output.ruleId,
        })
        .pipe(
          Effect.catchTag("TcpFlowProtectionRuleNotFound", () => Effect.void),
        );
    }),
  });

type ObservedRule =
  ddos.GetAdvancedTcpProtectionTcpFlowProtectionRuleItemResponse;

const ruleName = (props: {
  scope: TcpFlowProtectionRuleScope | string;
  name?: string;
}) => props.name ?? "global";

/**
 * Read a rule by id, mapping "gone" (`TcpFlowProtectionRuleNotFound`,
 * HTTP 404) to `undefined`.
 */
const getRule = (accountId: string, ruleId: string) =>
  ddos
    .getAdvancedTcpProtectionTcpFlowProtectionRuleItem({ accountId, ruleId })
    .pipe(
      Effect.map((rule): ObservedRule | undefined => rule),
      Effect.catchTag("TcpFlowProtectionRuleNotFound", () =>
        Effect.succeed(undefined),
      ),
    );

/**
 * Find a rule by its scope + name identity. If several rules carry the same
 * pair, pick the oldest for determinism.
 */
const findByScopeAndName = (accountId: string, scope: string, name: string) =>
  ddos.listAdvancedTcpProtectionTcpFlowProtectionRules
    .items({ accountId })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk)
          .filter((rule) => rule.scope === scope && rule.name === name)
          .sort((a, b) => a.createdOn.localeCompare(b.createdOn))
          .at(0),
      ),
    );

const toAttributes = (
  rule: ObservedRule,
  accountId: string,
): TcpFlowProtectionRuleAttributes => ({
  ruleId: rule.id,
  accountId,
  // Distilled widens generated string enums to plain strings.
  scope: rule.scope as TcpFlowProtectionRuleScope,
  name: rule.name,
  mode: rule.mode as TcpFlowProtectionRuleMode,
  burstSensitivity: rule.burstSensitivity as TcpFlowProtectionRuleSensitivity,
  rateSensitivity: rule.rateSensitivity as TcpFlowProtectionRuleSensitivity,
  createdOn: rule.createdOn,
  modifiedOn: rule.modifiedOn,
});
