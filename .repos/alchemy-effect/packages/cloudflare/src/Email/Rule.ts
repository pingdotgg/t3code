import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { resolveZoneId, type Reference } from "../Zone/index.ts";
import { listAllZones } from "../Zone/lookup.ts";
import { retryWorkerScriptNotFound } from "./retry.ts";

export type Matcher = { type: "all" } | { type: "literal"; field: "to"; value: string };

export type Action =
  | { type: "drop" }
  | { type: "forward"; value: string[] }
  | { type: "worker"; value: string[] };

export type RuleProps = {
  /**
   * Zone the rule lives on.
   */
  zone: Reference;
  /**
   * Display name for the rule.
   */
  name?: string;
  /**
   * Whether the rule is active. Disabled rules are evaluated last and
   * effectively skipped.
   *
   * @default true
   */
  enabled?: boolean;
  /**
   * Lower priority numbers run first.
   *
   * @default 0
   */
  priority?: number;
  /**
   * Matchers that define which inbound emails trigger this rule.
   *
   * A sole `{ type: "all" }` matcher is the zone catch-all, which is a
   * per-zone singleton owned by `Cloudflare.Email.CatchAll` — declaring
   * it here fails with `CatchAllRuleNotSupported`.
   */
  matchers: Matcher[];
  /**
   * Actions to take for matched emails.
   */
  actions: Action[];
};

export type Rule = Resource<
  "Cloudflare.Email.Rule",
  RuleProps,
  {
    ruleId: string;
    zoneId: string;
    name: string;
    enabled: boolean;
    priority: number;
    matchers: Matcher[];
    actions: Action[];
  },
  never,
  Providers
>;

/**
 * Raised when `Cloudflare.Email.Rule` is declared with a sole
 * `{ type: "all" }` matcher. Cloudflare models the zone catch-all as a
 * singleton behind `PUT /zones/{zone_id}/email/routing/rules/catch_all`
 * and rejects creating a second one through the ordinary rule endpoint
 * (`Conflict: Invalid rule operation`). Use `Cloudflare.Email.CatchAll`.
 */
export class CatchAllRuleNotSupported extends Data.TaggedError("CatchAllRuleNotSupported")<{
  message: string;
}> {}

/**
 * A Cloudflare Email Routing rule.
 *
 * Rules forward inbound mail matching `matchers` to the listed actions
 * (forward to a verified destination, drop, or hand off to a Worker).
 *
 * Safety: routing rules carry no ownership markers. When there is no
 * prior state, `read` scans the zone for an existing non-catch-all rule
 * with the same matchers and reports it as `Unowned`, so the engine
 * refuses to take it over unless `--adopt` (or `adopt(true)`) is set.
 * The zone catch-all is excluded from that scan — it is owned by
 * `Email.CatchAll`.
 * ### Forwarding Mail
 * **Example:** Forward `info@` to a verified destination
 * ```typescript
 * const rule = yield* Cloudflare.Email.Rule("InfoForward", {
 *   zone: "example.com",
 *   matchers: [{ type: "literal", field: "to", value: "info@example.com" }],
 *   actions: [{ type: "forward", value: ["ops@example.com"] }],
 * });
 * ```
 *
 * ### Catch-all mail
 * The zone catch-all is a per-zone singleton managed by
 * `Cloudflare.Email.CatchAll` (PUT `/rules/catch_all`). Declaring
 * `matchers: [{ type: "all" }]` on a Rule fails with
 * `CatchAllRuleNotSupported` — Cloudflare rejects creating a second
 * catch-all through the ordinary rule endpoint.
 *
 * **Example:** Use CatchAll for unmatched mail
 * ```typescript
 * yield* Cloudflare.Email.CatchAll("CatchAll", {
 *   zone: "example.com",
 *   actions: [{ type: "drop" }],
 * });
 * ```
 *
 * @resource
 * @product Email
 * @category Email
 */
export const Rule = Resource<Rule>("Cloudflare.Email.Rule", {
  aliases: ["Cloudflare.EmailRule"],
});

export const RuleProvider = () =>
  Provider.succeed(Rule, {
    stables: ["ruleId", "zoneId"],
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Email routing rules are zone-scoped (`/zones/{id}/email/routing/rules`)
      // with no account-wide enumeration API — fan out over every zone and
      // exhaustively paginate each zone's rules.
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          emailRouting.listRules.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? [])
                  // Cloudflare returns the zone's catch-all rule in this list,
                  // but it's a managed singleton (owned by `CatchAll`, via
                  // `/rules/catch_all`) and rejects deletion through the regular
                  // rule endpoint ("Invalid rule operation"). Identify it by its
                  // sole `{ type: "all" }` matcher and exclude it.
                  .filter((rule) => !isCatchAllRule(rule))
                  .map((rule) => normalize(rule, zone.id)),
              ),
            ),
            // Zones without email routing (or otherwise non-routable) reject
            // the route; skip them rather than failing the whole listing.
            Effect.catchTag("InvalidRoute", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!output) return undefined;
      if (!isResolved(news)) return undefined;
      const zoneId = yield* resolve(news.zone);
      if (zoneId !== output.zoneId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output, olds }) {
      const zoneId =
        output?.zoneId ?? (olds?.zone !== undefined ? yield* resolve(olds.zone) : undefined);
      if (!zoneId) return undefined;

      // Owned path: refresh by our persisted rule id. A catch-all id is
      // treated as missing — that singleton is owned by `CatchAll`.
      if (output?.ruleId) {
        const observed = yield* observeById(zoneId, output.ruleId);
        if (observed) return observed;
      }

      // Adoption path: Cloudflare uniqueness is by matcher shape, and
      // rules carry no ownership markers, so brand a match `Unowned`.
      // Never adopt the zone catch-all this way.
      const matchers = output?.matchers ?? asMatchers(olds?.matchers);
      if (matchers && !isCatchAllMatchers(matchers)) {
        const observed = yield* findByMatchers(zoneId, matchers);
        if (observed) return Unowned(observed);
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const zoneId = output?.zoneId ?? (yield* resolve(news.zone));
      const desired = toDesired(news);

      // The zone catch-all is a singleton behind `/rules/catch_all`.
      // Creating it as an ordinary rule 409s ("Invalid rule operation")
      // and deleting it through the rule endpoint does the same — refuse
      // before any write and point at `Email.CatchAll`.
      if (isCatchAllMatchers(desired.matchers)) {
        return yield* new CatchAllRuleNotSupported({
          message:
            'Cloudflare.Email.Rule cannot manage the zone catch-all (matchers: [{ type: "all" }]). ' +
            "Cloudflare models that as a per-zone singleton behind PUT /zones/{zone_id}/email/routing/rules/catch_all. " +
            "Use Cloudflare.Email.CatchAll instead.",
        });
      }

      // 1. Observe — cached id is a hint, not a guarantee the rule still
      //    exists. A missing id falls through to the matcher scan.
      let observed = output?.ruleId ? yield* observeById(zoneId, output.ruleId) : undefined;

      // 2. Fall back to scanning the zone for the same matchers.
      //    `read` brands an existing match `Unowned` so the engine can
      //    gate takeover behind adopt — but plan skips that probe when
      //    props are still unresolved (e.g. `zone: routing.zoneId` from
      //    a sibling created in the same deploy). In that case this scan
      //    is the AlreadyExists race: Cloudflare rejects a second rule
      //    with the same literal matchers, so converging on the match is
      //    the same as catching Conflict and re-listing.
      if (!observed) {
        observed = yield* findByMatchers(zoneId, desired.matchers);
      }

      // 3. Ensure — create when missing. The rejected call creates
      //    nothing, so a Worker-script retry cannot duplicate the rule.
      if (!observed) {
        const created = yield* emailRouting
          .createRule({
            zoneId,
            actions: desired.actions.map(toActionBody),
            matchers: desired.matchers.map(toMatcherBody),
            enabled: desired.enabled,
            name: desired.name,
            priority: desired.priority,
          })
          .pipe(retryWorkerScriptNotFound);
        observed = normalize(created, zoneId);
      }

      // 4. Sync — PUT the full desired body when observed state drifts.
      if (!sameRule(observed, desired)) {
        const updated = yield* emailRouting
          .updateRule({
            zoneId,
            ruleIdentifier: observed.ruleId,
            actions: desired.actions.map(toActionBody),
            matchers: desired.matchers.map(toMatcherBody),
            enabled: desired.enabled,
            name: desired.name,
            priority: desired.priority,
          })
          .pipe(retryWorkerScriptNotFound);
        observed = normalize(updated, zoneId);
      }

      return observed;
    }),
    delete: Effect.fn(function* ({ output }) {
      if (!output?.ruleId) return;
      // Never attempt to delete the zone catch-all through this endpoint
      // — Cloudflare rejects it with "Invalid rule operation".
      if (isCatchAllMatchers(output.matchers)) return;
      // Idempotent: a rule that's already gone is success. Any other error
      // (e.g. a 409 because email routing is disabled) must surface so the
      // engine reports the failure instead of falsely claiming deletion.
      yield* emailRouting
        .deleteRule({
          zoneId: output.zoneId,
          ruleIdentifier: output.ruleId,
        })
        .pipe(Effect.catchTag("EmailRoutingRuleNotFound", () => Effect.void));
    }),
  });

/**
 * The zone catch-all rule is surfaced by `listRules` but is a managed
 * singleton — its sole matcher is `{ type: "all" }`. It can only be mutated
 * via `/rules/catch_all` (the `CatchAll` resource), so it must be
 * excluded from the deletable `Rule` enumeration.
 */
const isCatchAllRule = (rule: { matchers?: { type: string }[] | null }): boolean =>
  (rule.matchers ?? []).length === 1 && rule.matchers?.[0]?.type === "all";

const isCatchAllMatchers = (matchers: Matcher[]): boolean =>
  matchers.length === 1 && matchers[0]?.type === "all";

// `olds.matchers` may still be unresolved Inputs after stripUnresolved;
// only treat a concrete array as matcher identity for the adoption scan.
const asMatchers = (value: unknown): Matcher[] | undefined =>
  Array.isArray(value) ? (value as Matcher[]) : undefined;

type RuleAttributes = {
  ruleId: string;
  zoneId: string;
  name: string;
  enabled: boolean;
  priority: number;
  matchers: Matcher[];
  actions: Action[];
};

const toDesired = (news: RuleProps): Omit<RuleAttributes, "ruleId" | "zoneId"> => ({
  name: news.name ?? "",
  enabled: news.enabled ?? true,
  priority: news.priority ?? 0,
  matchers: news.matchers.map((m): Matcher =>
    m.type === "all" ? { type: "all" } : { type: "literal", field: "to", value: m.value },
  ),
  actions: news.actions.map((a): Action =>
    a.type === "drop"
      ? { type: "drop" }
      : a.type === "forward"
        ? { type: "forward", value: a.value }
        : { type: "worker", value: a.value },
  ),
});

const toMatcherBody = (m: Matcher) =>
  m.type === "all"
    ? { type: "all" as const }
    : { type: "literal" as const, field: "to" as const, value: m.value };

const toActionBody = (a: Action) =>
  a.type === "drop" ? { type: a.type } : { type: a.type, value: a.value };

const matchersEqual = (a: Matcher[], b: Matcher[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]!;
    if (x.type !== y.type) return false;
    if (x.type === "all") return true;
    return y.type === "literal" && x.field === y.field && x.value === y.value;
  });

const actionsEqual = (a: Action[], b: Action[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]!;
    if (x.type !== y.type) return false;
    const xv = x.type === "drop" ? [] : x.value;
    const yv = y.type === "drop" ? [] : y.value;
    return xv.length === yv.length && xv.every((v, j) => v === yv[j]);
  });

const sameRule = (
  observed: RuleAttributes,
  desired: Omit<RuleAttributes, "ruleId" | "zoneId">,
): boolean =>
  observed.enabled === desired.enabled &&
  observed.name === desired.name &&
  observed.priority === desired.priority &&
  matchersEqual(observed.matchers, desired.matchers) &&
  actionsEqual(observed.actions, desired.actions);

const normalize = (
  rule: {
    id?: string | null;
    name?: string | null;
    enabled?: boolean | null;
    priority?: number | null;
    // Distilled widened generated string enums to open unions (`string & {}`);
    // the runtime values are still the known variants, narrowed below.
    matchers?:
      | {
          type: string;
          field?: string | null;
          value?: string | null;
        }[]
      | null;
    actions?: { type: string; value?: string[] | null }[] | null;
  },
  zoneId: string,
): RuleAttributes => ({
  ruleId: rule.id ?? "",
  zoneId,
  name: rule.name ?? "",
  enabled: rule.enabled ?? true,
  priority: rule.priority ?? 0,
  matchers: (rule.matchers ?? []).map((m): Matcher =>
    m.type === "all" ? { type: "all" } : { type: "literal", field: "to", value: m.value ?? "" },
  ),
  actions: (rule.actions ?? []).map((a): Action =>
    a.type === "drop"
      ? { type: "drop" }
      : a.type === "forward"
        ? { type: "forward", value: a.value ?? [] }
        : { type: "worker", value: a.value ?? [] },
  ),
});

const observeById = (zoneId: string, ruleId: string) =>
  emailRouting.getRule({ zoneId, ruleIdentifier: ruleId }).pipe(
    Effect.map((rule) => (isCatchAllRule(rule) ? undefined : normalize(rule, zoneId))),
    Effect.catchTag(["EmailRoutingRuleNotFound", "Forbidden"], () => Effect.undefined),
  );

/**
 * Locate an existing non-catch-all rule by matcher identity. Cloudflare
 * rejects a second catch-all and treats matcher shape as the rule's
 * identity, so a match is the same logical rule.
 */
const findByMatchers = (zoneId: string, matchers: Matcher[]) =>
  emailRouting.listRules.items({ zoneId }).pipe(
    Stream.filter(
      (rule) => !isCatchAllRule(rule) && matchersEqual(normalize(rule, zoneId).matchers, matchers),
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.map((rule) => (rule ? normalize(rule, zoneId) : undefined)),
    Effect.catchTag("InvalidRoute", () => Effect.undefined),
  );

const resolve = Effect.fn(function* (zone: Reference) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* resolveZoneId({
    accountId,
    zone,
    hostname: typeof zone === "string" ? zone : (zone.name ?? ""),
  });
});
