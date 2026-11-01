import * as appengine from "@distilled.cloud/gcp/appengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  CATCH_ALL_PRIORITY,
  catchMissing,
  DEFAULT_ACTION,
  DEFAULT_SOURCE_RANGE,
  encodeOwnership,
  findOwnedFirewallRule,
  hasOwnershipMarker,
  ignoreMissing,
  listFirewallRules,
  MAX_DESCRIPTION_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  resolveAppsId,
  sameText,
  toPriority,
  updateMaskOf,
} from "./internal.ts";

export type AppsFirewallIngressRuleProps = {
  /**
   * App Engine application id. Defaults to the current GCP project.
   * Immutable — changing it replaces the rule.
   */
  appsId?: string;
  /**
   * Rule priority (lower is evaluated first). If omitted, a unique
   * priority in `10000-910000` is generated. Immutable — changing it
   * replaces the rule. The default catch-all (`2147483647`) cannot be
   * deleted.
   */
  priority?: number;
  /**
   * Action taken on matching requests.
   * @default "ALLOW"
   */
  action?: appengine.FirewallRuleActionEnum | (string & {});
  /**
   * CIDR source range. `"*"` matches all IPv4 and IPv6 addresses.
   * @default "*"
   */
  sourceRange?: string;
  /**
   * Human-readable description (max 400 characters). Firewall rules have
   * no labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  description?: string;
};

export type AppsFirewallIngressRule = Resource<
  "GCP.AppEngine.AppsFirewallIngressRule",
  AppsFirewallIngressRuleProps,
  {
    /** App Engine application id. */
    appsId: string;
    /** Project id. */
    project: string;
    /** Rule priority (the `{ingressRulesId}` path segment). */
    priority: number;
    /** ALLOW or DENY. */
    action: string;
    /** CIDR source range. */
    sourceRange: string | undefined;
    /** Description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
  },
  never,
  Providers
>;

/**
 * An App Engine ingress firewall rule.
 *
 * Firewall rules have no labels field, so Alchemy stamps ownership into
 * `description` for `list` / nuke. Application id and priority are
 * identity — changing either replaces the rule. Action, source range,
 * and description update in place.
 *
 * ### Creating a Rule
 * **Example:** Deny a CIDR range
 * ```typescript
 * const rule = yield* GCP.AppEngine.AppsFirewallIngressRule("BlockOffice", {
 *   action: "DENY",
 *   sourceRange: "203.0.113.0/24",
 *   description: "office network",
 * });
 * ```
 *
 * **Example:** Explicit priority
 * ```typescript
 * const rule = yield* GCP.AppEngine.AppsFirewallIngressRule("AllowHealth", {
 *   priority: 12000,
 *   action: "ALLOW",
 *   sourceRange: "35.191.0.0/16",
 * });
 * ```
 *
 * ### Updating a Rule
 * **Example:** Flip the action
 * ```typescript
 * const rule = yield* GCP.AppEngine.AppsFirewallIngressRule("BlockOffice", {
 *   action: "ALLOW",
 *   sourceRange: "203.0.113.0/24",
 * });
 * ```
 *
 * @resource
 * @category AppEngine
 */
export const AppsFirewallIngressRule = Resource<AppsFirewallIngressRule>(
  "GCP.AppEngine.AppsFirewallIngressRule",
);

export class AppsFirewallIngressRuleNotResolved extends Data.TaggedError(
  "GCP.AppEngine.AppsFirewallIngressRuleNotResolved",
)<{
  appsId: string;
  priority: number;
}> {}

const toAttrs = (
  rule: appengine.FirewallRule,
  appsId: string,
  project: string,
) => ({
  appsId,
  project,
  priority: rule.priority ?? 0,
  action: String(rule.action ?? DEFAULT_ACTION),
  sourceRange: rule.sourceRange,
  description: parseOwnership(rule.description).text,
});

const getByPriority = (appsId: string, priority: number) =>
  catchMissing(
    appengine.getAppsFirewallIngressRules({
      appsId,
      ingressRulesId: String(priority),
    }),
  );

export const AppsFirewallIngressRuleProvider = () =>
  Provider.succeed(AppsFirewallIngressRule, {
    stables: ["appsId", "project", "priority"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousApp = olds?.appsId ?? output?.appsId;
      const nextApp = news.appsId ?? previousApp;
      if (
        previousApp !== undefined &&
        nextApp !== undefined &&
        nextApp !== previousApp
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousPriority = olds?.priority ?? output?.priority;
      if (
        previousPriority !== undefined &&
        news.priority !== undefined &&
        news.priority !== previousPriority
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const appsId = yield* resolveAppsId(olds?.appsId, output?.appsId);
      const priority = olds?.priority ?? output?.priority;
      let existing =
        priority === undefined
          ? undefined
          : yield* getByPriority(appsId, priority);
      if (existing === undefined) {
        existing = yield* findOwnedFirewallRule(
          id,
          yield* listFirewallRules(appsId),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, appsId, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rules = yield* listFirewallRules(env.project);
        return rules
          .filter((rule) => hasOwnershipMarker(rule.description))
          .map((rule) => toAttrs(rule, env.project, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const appsId = yield* resolveAppsId(news.appsId, output?.appsId);
      const ownership = yield* ownershipLabels(id);
      const description = encodeOwnership(
        ownership,
        news.description,
        MAX_DESCRIPTION_LENGTH,
      );
      const priority = yield* toPriority(id, news.priority, output?.priority);
      const action = news.action ?? DEFAULT_ACTION;
      const sourceRange = news.sourceRange ?? DEFAULT_SOURCE_RANGE;

      let current = yield* getByPriority(appsId, priority);
      if (current === undefined) {
        current = yield* findOwnedFirewallRule(
          id,
          yield* listFirewallRules(appsId),
        );
      }

      if (current === undefined) {
        const created = yield* appengine
          .createAppsFirewallIngressRules({
            appsId,
            body: {
              priority,
              action,
              sourceRange,
              description,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => getByPriority(appsId, priority)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppsFirewallIngressRuleNotResolved({
          appsId,
          priority,
        });
      }

      const observedPriority = current.priority ?? priority;
      const actionChanged = !sameText(String(current.action ?? ""), action);
      const rangeChanged = !sameText(current.sourceRange, sourceRange);
      const descriptionChanged = !sameText(current.description, description);
      const updateMask = updateMaskOf(
        actionChanged ? "action" : undefined,
        rangeChanged ? "sourceRange" : undefined,
        descriptionChanged ? "description" : undefined,
      );
      if (updateMask.length > 0) {
        current = yield* appengine.patchAppsFirewallIngressRules({
          appsId,
          ingressRulesId: String(observedPriority),
          updateMask,
          body: {
            priority: observedPriority,
            action,
            sourceRange,
            description,
          },
        });
      }

      return toAttrs(current, appsId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.priority === CATCH_ALL_PRIORITY) return;
      yield* ignoreMissing(
        appengine.deleteAppsFirewallIngressRules({
          appsId: output.appsId,
          ingressRulesId: String(output.priority),
        }),
      );
    }),
  });
