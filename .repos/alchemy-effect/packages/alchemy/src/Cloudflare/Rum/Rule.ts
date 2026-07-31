import * as rum from "@distilled.cloud/cloudflare/rum";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Rum.Rule" as const;
type TypeId = typeof TypeId;

export type RuleProps = {
  /**
   * The identifier of the Web Analytics ruleset the rule belongs to.
   * Each zone-based (orange-clouded) `Site` owns one implicit ruleset —
   * pass its `rulesetId` attribute. Changing this property triggers a
   * replacement.
   */
  rulesetId: string;
  /**
   * The hostname the rule applies to (e.g. `example.com`).
   */
  host?: string;
  /**
   * The paths the rule applies to (e.g. `["/blog/*"]`).
   */
  paths?: string[];
  /**
   * Whether the rule includes (`true`) or excludes (`false`) matching
   * traffic from being measured.
   * @default true
   */
  inclusive?: boolean;
  /**
   * Whether the rule is paused.
   * @default false
   */
  isPaused?: boolean;
};

export type RuleAttributes = {
  /**
   * The Web Analytics rule identifier. Stable for the lifetime of the rule.
   */
  id: string;
  /**
   * The identifier of the ruleset the rule belongs to.
   */
  rulesetId: string;
  /**
   * The Cloudflare account the rule belongs to.
   */
  accountId: string;
  /**
   * The hostname the rule applies to.
   */
  host: string | undefined;
  /**
   * The paths the rule applies to.
   */
  paths: string[] | undefined;
  /**
   * Whether the rule includes or excludes matching traffic from being
   * measured.
   */
  inclusive: boolean;
  /**
   * Whether the rule is paused.
   */
  isPaused: boolean;
  /**
   * The rule's evaluation priority within its ruleset (assigned by
   * Cloudflare).
   */
  priority: number | undefined;
  /**
   * When the rule was created.
   */
  created: string | undefined;
};

export type Rule = Resource<
  TypeId,
  RuleProps,
  RuleAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Web Analytics (RUM) rule.
 *
 * Rules include or exclude traffic from Web Analytics measurement by
 * hostname and path patterns. They live under the implicit ruleset of a
 * zone-based (orange-clouded) `Site` — pass the site's `rulesetId`
 * attribute. Host, paths, `inclusive`, and `isPaused` are all mutable in
 * place; changing `rulesetId` triggers a replacement.
 *
 * Web Analytics is available on free accounts.
 * @resource
 * @product RUM
 * @category Observability & Analytics
 * @section Excluding traffic
 * @example Exclude a path from measurement
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Zone", { name: "example.com" });
 *
 * const site = yield* Cloudflare.Rum.Site("Analytics", {
 *   zoneTag: zone.zoneId,
 *   autoInstall: true,
 * });
 *
 * yield* Cloudflare.Rum.Rule("ExcludeAdmin", {
 *   rulesetId: site.rulesetId.as<string>(),
 *   host: "example.com",
 *   paths: ["/admin/*"],
 *   inclusive: false,
 * });
 * ```
 *
 * @section Pausing a rule
 * @example Keep the rule but stop applying it
 * ```typescript
 * yield* Cloudflare.Rum.Rule("ExcludeAdmin", {
 *   rulesetId: site.rulesetId.as<string>(),
 *   host: "example.com",
 *   paths: ["/admin/*"],
 *   inclusive: false,
 *   isPaused: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/web-analytics/
 */
export const Rule = Resource<Rule>(TypeId);

/**
 * Returns true if the given value is a Rule resource.
 */
export const isRule = (value: unknown): value is Rule =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const RuleProvider = () =>
  Provider.succeed(Rule, {
    stables: ["id", "rulesetId", "accountId", "created"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Rules live under a Site's implicit ruleset and there is no
      // account-wide rule list. Enumerate every site (paginated), collect
      // their ruleset ids, then fan out the per-ruleset rule list and
      // flatten — the same listRules read path each rule's `read` uses.
      const sites = yield* rum.listSiteInfos.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) => page.result ?? []),
        ),
      );
      const rulesetIds = Array.from(
        new Set(
          sites
            .map((site) => site.ruleset?.id ?? undefined)
            .filter((id): id is string => id !== undefined),
        ),
      );
      const rows = yield* Effect.forEach(
        rulesetIds,
        (rulesetId) =>
          listRules(accountId, rulesetId).pipe(
            Effect.map((rules) =>
              (rules ?? []).map((rule) =>
                toAttributes(rule, rulesetId, accountId),
              ),
            ),
            // A freshly minted scoped token can briefly 403 across the
            // edge — skip rulesets we momentarily can't read.
            Effect.catchTag("Forbidden", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // A rule cannot be moved between rulesets — moving it means a new
      // rule under the new ruleset.
      if (output !== undefined && news.rulesetId !== output.rulesetId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const rulesetId =
        output?.rulesetId ??
        (typeof olds?.rulesetId === "string" ? olds.rulesetId : undefined);
      if (rulesetId === undefined) return undefined;

      // There is no getRule — read through the ruleset's rule list. A
      // deleted ruleset (the parent site is gone) means the rule is gone.
      const rules = yield* listRules(acct, rulesetId);
      if (rules === undefined) return undefined;

      // Owned path: refresh by our persisted rule id.
      if (output?.id) {
        const observed = rules.find((rule) => rule.id === output.id);
        return observed ? toAttributes(observed, rulesetId, acct) : undefined;
      }

      // Adoption path: rules carry no ownership markers, so a rule matching
      // the same host+paths cannot be proven ours — brand it `Unowned` so
      // the engine refuses to take over unless `adopt` is set.
      if (olds !== undefined && isResolved(olds)) {
        const match = rules
          .filter(
            (rule) =>
              (rule.host ?? undefined) === olds.host &&
              samePaths(rule.paths ?? undefined, olds.paths),
          )
          .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""))
          .at(0);
        if (match) return Unowned(toAttributes(match, rulesetId, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const rulesetId = news.rulesetId as string;

      // 1. Observe — the rule id cached on `output` is a hint, not a
      //    guarantee: a missing rule (or ruleset) falls through to create.
      const rules =
        output?.id !== undefined && output.rulesetId === rulesetId
          ? yield* listRules(accountId, rulesetId)
          : undefined;
      let observed = rules?.find((rule) => rule.id === output?.id);

      // 2. Ensure — create when missing. Rules have no uniqueness
      //    constraint, so there is no AlreadyExists race to tolerate. The
      //    API rejects bodies with absent `inclusive`/`is_paused`
      //    (`web_analytics.configuration.form.*.invalid`), so always send
      //    the full body with defaults. The create response omits
      //    `priority`, so re-read the rule from the list for the complete
      //    state.
      if (!observed) {
        const created = yield* rum
          .createRule({
            accountId,
            rulesetId,
            host: news.host,
            paths: news.paths ?? [],
            inclusive: news.inclusive ?? true,
            isPaused: news.isPaused ?? false,
          })
          .pipe(
            // The implicit ruleset of a freshly-created Site is eventually
            // consistent: a createRule issued immediately after the site
            // deploy can briefly 404 (`RulesetNotFound`, code
            // `web_analytics.configuration.api.notFound`) before the ruleset is
            // visible. Ride out the propagation window with a bounded retry.
            Effect.retry({
              while: (e) => e._tag === "RulesetNotFound",
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(8),
              ]),
            }),
          );
        const fresh = yield* listRules(accountId, rulesetId);
        observed =
          fresh?.find((rule) => rule.id === created.id) ?? toRule(created);
        return toAttributes(observed, rulesetId, accountId);
      }

      // 3. Sync — diff observed cloud state against desired. The update
      //    API is a PUT; send the full desired body, but skip the call
      //    entirely on a no-op. Unspecified props keep their observed
      //    values.
      const desired = {
        host: news.host ?? observed.host ?? undefined,
        paths: news.paths ?? [...(observed.paths ?? [])],
        inclusive: news.inclusive ?? observed.inclusive ?? true,
        isPaused: news.isPaused ?? observed.isPaused ?? false,
      };
      const dirty =
        (observed.host ?? undefined) !== desired.host ||
        !samePaths(observed.paths ?? undefined, desired.paths) ||
        (observed.inclusive ?? true) !== desired.inclusive ||
        (observed.isPaused ?? false) !== desired.isPaused;
      if (!dirty) {
        return toAttributes(observed, rulesetId, accountId);
      }

      const updated = yield* rum.updateRule({
        accountId,
        rulesetId,
        ruleId: observed.id ?? "",
        ...desired,
      });
      return toAttributes(
        { ...toRule(updated), priority: updated.priority ?? observed.priority },
        rulesetId,
        accountId,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* rum
        .deleteRule({
          accountId: output.accountId,
          rulesetId: output.rulesetId,
          ruleId: output.id,
        })
        .pipe(
          // `RuleNotFound` (code 10003) — the rule is already gone;
          // `RulesetNotFound` (404) — the parent site/ruleset is gone,
          // taking the rule with it. Both make delete a success.
          Effect.catchTag(
            ["RuleNotFound", "RulesetNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });

type ObservedRule = NonNullable<
  NonNullable<rum.ListRulesResponse["rules"]>
>[number];

/**
 * List the rules of a ruleset, mapping "ruleset gone" (`RulesetNotFound`,
 * HTTP 404 `web_analytics.configuration.api.notFound`) to `undefined`.
 */
const listRules = (accountId: string, rulesetId: string) =>
  rum.listRules({ accountId, rulesetId }).pipe(
    Effect.map(
      (response): readonly ObservedRule[] | undefined => response.rules ?? [],
    ),
    Effect.catchTag("RulesetNotFound", () => Effect.succeed(undefined)),
  );

const toRule = (
  rule: rum.CreateRuleResponse | rum.UpdateRuleResponse,
): ObservedRule => rule;

const samePaths = (
  observed: readonly string[] | undefined,
  desired: readonly string[] | undefined,
) =>
  (observed ?? []).length === (desired ?? []).length &&
  (observed ?? []).join(" ") === (desired ?? []).join(" ");

const toAttributes = (
  rule: ObservedRule,
  rulesetId: string,
  accountId: string,
): RuleAttributes => ({
  id: rule.id ?? "",
  rulesetId,
  accountId,
  host: rule.host ?? undefined,
  paths: rule.paths ? [...rule.paths] : undefined,
  inclusive: rule.inclusive ?? true,
  isPaused: rule.isPaused ?? false,
  priority: rule.priority ?? undefined,
  created: rule.created ?? undefined,
});
