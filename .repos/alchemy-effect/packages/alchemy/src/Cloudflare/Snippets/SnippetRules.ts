import * as snippets from "@distilled.cloud/cloudflare/snippets";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

/**
 * A single rule mapping a traffic expression to a snippet.
 */
export interface SnippetRule {
  /**
   * Name of the snippet to execute when the expression matches. Reference
   * a `Snippet` resource's `name` output to create the dependency edge so
   * the snippet is created before the rule (and deleted after it).
   */
  snippetName: string;
  /**
   * Cloudflare Rules language expression selecting the traffic the
   * snippet runs on, e.g. `http.request.uri.path wildcard "/api/*"`.
   */
  expression: string;
  /**
   * Whether the rule is enabled.
   * @default true
   */
  enabled?: boolean;
  /**
   * Informative description of the rule.
   */
  description?: string;
}

export interface SnippetRulesProps {
  /**
   * Zone the rules apply to. Stable — changing the zone triggers
   * replacement.
   */
  zoneId: string;
  /**
   * Ordered list of snippet rules. The whole list is owned by this
   * resource and replaced atomically on every change — rules managed
   * elsewhere in the zone will be overwritten on deploy.
   */
  rules: SnippetRule[];
}

/**
 * A snippet rule as Cloudflare reports it.
 */
export interface SnippetRuleAttribute {
  /** Name of the snippet the rule executes. */
  snippetName: string;
  /** Rules language expression selecting matching traffic. */
  expression: string;
  /** Whether the rule is enabled. */
  enabled: boolean;
  /** Informative description of the rule. */
  description: string | undefined;
}

export interface SnippetRulesAttributes {
  /** Zone that owns the rule list. */
  zoneId: string;
  /** The ordered rule list as Cloudflare reports it. */
  rules: SnippetRuleAttribute[];
}

export type SnippetRules = Resource<
  "Cloudflare.Snippets.Rules",
  SnippetRulesProps,
  SnippetRulesAttributes,
  never,
  Providers
>;

/**
 * The ordered list of snippet rules for a Cloudflare zone.
 *
 * Snippet rules activate snippets against traffic: each rule pairs a
 * Rules-language expression with the name of the snippet to execute on
 * matching requests. The zone has exactly one rule list — this resource
 * owns it in its entirety (PUT-replace semantics), so there should be at
 * most one `SnippetRules` resource per zone.
 *
 * Safety: when there is no prior state and the zone already has a
 * non-empty rule list, `read` reports it as `Unowned` and the engine
 * refuses to take it over unless `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Snippets
 * @category Rules & Configuration
 * @section Activating Snippets
 * @example Route a path through a snippet
 * ```typescript
 * const snippet = yield* Cloudflare.Snippets.Snippet("HeaderSnippet", {
 *   zoneId: zone.zoneId,
 *   code: snippetCode,
 * });
 *
 * yield* Cloudflare.Snippets.SnippetRules("Rules", {
 *   zoneId: zone.zoneId,
 *   rules: [
 *     {
 *       snippetName: snippet.name,
 *       expression: 'http.request.uri.path wildcard "/api/*"',
 *       description: "add headers to API responses",
 *     },
 *   ],
 * });
 * ```
 */
export const SnippetRules = Resource<SnippetRules>("Cloudflare.Snippets.Rules");

export const isSnippetRules = (value: unknown): value is SnippetRules =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === "Cloudflare.Snippets.Rules";

export const SnippetRulesProvider = () =>
  Provider.succeed(SnippetRules, {
    stables: ["zoneId"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Snippet rules are a per-zone singleton with no account-wide list
      // API — enumerate every zone and read its rule list. Zones with no
      // rules have nothing to manage (matches `read` returning undefined
      // for an empty list), so skip them.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          listObservedRules(zoneId).pipe(
            Effect.map((rules): SnippetRulesAttributes | undefined =>
              rules.length === 0 ? undefined : { zoneId, rules },
            ),
            // Plan-gated zones (and eventually-consistent token 401/403s)
            // reject the route; skip them. (`listObservedRules` already maps
            // the snippet-rules 404 to an empty list, which becomes
            // `undefined` above.)
            Effect.catchTag(["Forbidden", "Unauthorized"], () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is SnippetRulesAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      const o = olds as SnippetRulesProps;
      const n = news as SnippetRulesProps;
      const oldZoneId =
        output?.zoneId ?? (typeof o.zoneId === "string" ? o.zoneId : undefined);
      if (
        typeof n.zoneId === "string" &&
        oldZoneId !== undefined &&
        oldZoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      const observed = yield* listObservedRules(zoneId);
      if (observed.length === 0) return undefined;
      const attrs: SnippetRulesAttributes = { zoneId, rules: observed };
      // No prior state of our own but the zone already has rules — they
      // may be managed by hand or by another tool. Refuse to take over
      // unless adoption is explicitly allowed.
      if (output === undefined) return Unowned(attrs);
      return attrs;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete values by Plan.
      const zoneId = (output?.zoneId ?? news.zoneId) as string;
      const desired = news.rules.map((rule) => ({
        snippetName: rule.snippetName as string,
        expression: rule.expression,
        enabled: rule.enabled ?? true,
        description: rule.description,
      }));

      // Observe the live rule list and skip the PUT when it already
      // matches the desired state.
      const observed = yield* listObservedRules(zoneId);
      if (!rulesEqual(desired, observed)) {
        yield* snippets.putRule({ zoneId, rules: desired });
      }

      // Re-read so attributes reflect Cloudflare's canonical view.
      const synced = yield* listObservedRules(zoneId);
      return { zoneId, rules: synced } satisfies SnippetRulesAttributes;
    }),

    delete: Effect.fn(function* ({ output }) {
      // `deleteRule` removes the zone's entire rule list; deleting an
      // already-empty list succeeds, making this naturally idempotent.
      yield* snippets
        .deleteRule({ zoneId: output.zoneId })
        .pipe(Effect.catchTag("SnippetRulesNotFound", () => Effect.void));
    }),
  });

/**
 * `ListRulesResponse` is untyped in distilled (`unknown`); the wire shape
 * is an array of snake_case rule objects under `result`.
 */
interface WireRule {
  readonly snippet_name?: string;
  readonly expression?: string;
  readonly enabled?: boolean;
  readonly description?: string | null;
}

const listObservedRules = (zoneId: string) =>
  snippets.listRules({ zoneId }).pipe(
    // A zone that has never had a snippet-rule list 404s — there is simply
    // no rule list, which is equivalent to an empty one.
    Effect.catchTag("SnippetRulesNotFound", () => Effect.succeed([])),
    Effect.map((result): SnippetRuleAttribute[] => {
      if (!Array.isArray(result)) return [];
      return (result as WireRule[]).flatMap((rule) =>
        rule.snippet_name === undefined || rule.expression === undefined
          ? []
          : [
              {
                snippetName: rule.snippet_name,
                expression: rule.expression,
                enabled: rule.enabled ?? true,
                description: rule.description ?? undefined,
              },
            ],
      );
    }),
  );

const rulesEqual = (
  desired: ReadonlyArray<{
    snippetName: string;
    expression: string;
    enabled: boolean;
    description: string | undefined;
  }>,
  observed: ReadonlyArray<SnippetRuleAttribute>,
): boolean =>
  desired.length === observed.length &&
  desired.every((d, i) => {
    const o = observed[i];
    return (
      d.snippetName === o.snippetName &&
      d.expression === o.expression &&
      d.enabled === o.enabled &&
      (d.description ?? undefined) === o.description
    );
  });
