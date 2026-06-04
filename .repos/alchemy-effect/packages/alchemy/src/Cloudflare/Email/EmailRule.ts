import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { resolveZoneId, type ZoneReference } from "../Zone/index.ts";

export type EmailMatcher =
  | { type: "all" }
  | { type: "literal"; field: "to"; value: string };

export type EmailAction =
  | { type: "drop" }
  | { type: "forward"; value: string[] }
  | { type: "worker"; value: string[] };

export type EmailRuleProps = {
  /**
   * Zone the rule lives on.
   */
  zone: ZoneReference;
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
   */
  matchers: EmailMatcher[];
  /**
   * Actions to take for matched emails.
   */
  actions: EmailAction[];
};

export type EmailRule = Resource<
  "Cloudflare.EmailRule",
  EmailRuleProps,
  {
    ruleId: string;
    zoneId: string;
    name: string;
    enabled: boolean;
    priority: number;
    matchers: EmailMatcher[];
    actions: EmailAction[];
  },
  never,
  Providers
>;

/**
 * A Cloudflare Email Routing rule.
 *
 * Rules forward inbound mail matching `matchers` to the listed actions
 * (forward to a verified destination, drop, or hand off to a Worker).
 *
 * @section Forwarding Mail
 * @example Forward `info@` to a verified destination
 * ```typescript
 * const rule = yield* Cloudflare.EmailRule("InfoForward", {
 *   zone: "example.com",
 *   matchers: [{ type: "literal", field: "to", value: "info@example.com" }],
 *   actions: [{ type: "forward", value: ["ops@example.com"] }],
 * });
 * ```
 */
export const EmailRule = Resource<EmailRule>("Cloudflare.EmailRule");

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
) => ({
  ruleId: rule.id ?? "",
  zoneId,
  name: rule.name ?? "",
  enabled: rule.enabled ?? true,
  priority: rule.priority ?? 0,
  matchers: (rule.matchers ?? []).map(
    (m): EmailMatcher =>
      m.type === "all"
        ? { type: "all" }
        : { type: "literal", field: "to", value: m.value ?? "" },
  ),
  actions: (rule.actions ?? []).map(
    (a): EmailAction =>
      a.type === "drop"
        ? { type: "drop" }
        : a.type === "forward"
          ? { type: "forward", value: a.value ?? [] }
          : { type: "worker", value: a.value ?? [] },
  ),
});

export const EmailRuleProvider = () =>
  Provider.effect(
    EmailRule,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const create = yield* emailRouting.createRule;
      const update = yield* emailRouting.updateRule;
      const get = yield* emailRouting.getRule;
      const del = yield* emailRouting.deleteRule;

      const resolve = (zone: ZoneReference) =>
        resolveZoneId({
          accountId,
          zone,
          hostname: typeof zone === "string" ? zone : (zone.name ?? ""),
        });

      return {
        stables: ["ruleId", "zoneId"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!output) return undefined;
          if (!isResolved(news)) return undefined;
          const zoneId = yield* resolve(news.zone);
          if (zoneId !== output.zoneId) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.ruleId || !output?.zoneId) return undefined;
          return yield* get({
            zoneId: output.zoneId,
            ruleIdentifier: output.ruleId,
          }).pipe(
            Effect.map((r) => normalize(r, output.zoneId)),
            Effect.catch(() => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const zoneId = output?.zoneId ?? (yield* resolve(news.zone));
          const body = {
            actions: news.actions.map((a) =>
              a.type === "drop"
                ? { type: a.type }
                : { type: a.type, value: a.value },
            ),
            matchers: news.matchers.map((m) =>
              m.type === "all"
                ? { type: "all" as const }
                : {
                    type: "literal" as const,
                    field: "to" as const,
                    value: m.value,
                  },
            ),
            enabled: news.enabled ?? true,
            name: news.name ?? "",
            priority: news.priority ?? 0,
          };

          if (output?.ruleId) {
            const result = yield* update({
              zoneId,
              ruleIdentifier: output.ruleId,
              ...body,
            }).pipe(
              Effect.catch(() =>
                create({ zoneId, ...body }).pipe(Effect.map((r) => r)),
              ),
            );
            return normalize(result, zoneId);
          }

          const result = yield* create({ zoneId, ...body });
          return normalize(result, zoneId);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!output?.ruleId) return;
          yield* del({
            zoneId: output.zoneId,
            ruleIdentifier: output.ruleId,
          }).pipe(Effect.catch(() => Effect.void));
        }),
      };
    }),
  );
